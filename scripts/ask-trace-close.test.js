/**
 * Ask Trace keeps its answer when you click elsewhere (TraceApps/notetrace#35).
 *
 * The report: a click outside Ask Trace while it was working closed it, and
 * the answer was lost while the request still ran (and cost) to the end. Now
 * a click outside leaves it open while it works or has an answer waiting;
 * Escape, back or Cancel stops the request, at the provider too, and an
 * answer not used yet is only discarded once you say so.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeStep, createAsk } from '../src/lib/trace-close.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('what Escape or back does to Ask Trace', () => {
  assert.equal(closeStep({ busy: true }), 'stop', 'working: stop the request and close');
  assert.equal(closeStep({ waiting: true }), 'ask', 'an answer not used yet: ask first');
  assert.equal(closeStep({ waiting: true, asking: true }), 'keep', 'asked already: Escape again keeps it');
  assert.equal(closeStep({}), 'close', 'nothing to lose: close');
  assert.equal(closeStep({ busy: true, waiting: true, asking: true }), 'stop', 'working wins');
});

test('one request at a time: a late reply is never shown', async () => {
  // A stand-in Trace that answers when told to, and says what it was given.
  const calls = [];
  const fake = (args) => new Promise((resolve, reject) => { calls.push({ args, resolve, reject }); });
  const asker = createAsk(fake);
  // An answer: shown.
  let run = asker.run({ prompt: 'a' });
  calls[0].resolve('tidied');
  assert.deepEqual(await run, { reply: 'tidied' });
  assert.ok(calls[0].args.signal instanceof AbortSignal, 'the request can be stopped');
  // Stopped, then the provider answers anyway: not shown.
  run = asker.run({ prompt: 'b' });
  asker.stop();
  assert.equal(calls[1].args.signal.aborted, true);
  calls[1].resolve('late');
  assert.deepEqual(await run, { cancelled: true });
  // Stopped, then it fails: not an error to show either.
  run = asker.run({ prompt: 'c' });
  asker.stop();
  calls[2].reject(new Error('AbortError'));
  assert.deepEqual(await run, { cancelled: true });
  // Try Again before the first answer came: only the newer one counts.
  const first = asker.run({ prompt: 'd' });
  const second = asker.run({ prompt: 'e' });
  assert.equal(calls[3].args.signal.aborted, true, 'the older request is stopped');
  calls[3].resolve('old');
  calls[4].resolve('new');
  assert.deepEqual([await first, await second], [{ cancelled: true }, { reply: 'new' }]);
  // A real failure is still said.
  run = asker.run({ prompt: 'f' });
  calls[5].reject(new Error('Rate limited'));
  assert.equal((await run).error.message, 'Rate limited');
});

test('a click outside only closes Ask Trace when there is nothing to lose', () => {
  const pop = read('../src/components/notes/Popover.svelte');
  assert.match(pop, /export let closeOnOutside = true;/, 'every other popup closes on a click outside as before');
  assert.match(pop, /function closeOutside\(\) \{ if \(closeOnOutside\) close\(\); \}/);
  assert.match(pop, /use:backdropClick=\{closeOutside\} use:closeOnBack=\{close\}/, 'outside clicks go through the check; back still asks');
  assert.match(pop, /if \(beforeClose && beforeClose\(\) === false\) return;/);
  const editor = read('../src/components/notes/NoteEditor.svelte');
  assert.match(editor, /closeOnOutside=\{!traceHolding\} beforeClose=\{\(\) => traceActions\?\.requestClose\(\) \?\? true\}/);
  assert.match(editor, /<TraceActions bind:this=\{traceActions\} bind:holding=\{traceHolding\}/);
  const ta = read('../src/components/notes/TraceActions.svelte');
  assert.match(ta, /\$: holding = busy \|\| waiting;/);
  assert.match(ta, /onDestroy\(\(\) => asker\.stop\(\)\)/, 'closed any other way, the request stops');
  // A cancelled request says nothing, and focus follows what's on screen.
  assert.match(ta, /if \(out\.cancelled\) return;/);
  assert.match(ta, /\$: if \(confirmDiscard\) focusSoon\(\(\) => keepBtn\);/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.deepEqual([en.trace_actions.discard_question, en.trace_actions.keep, en.trace_actions.discard], ["Discard Trace's answer?", 'Keep', 'Discard']);
});

// ── The request really stops ────────────────────────────────────────────
// A stand-in fetch that never answers until it's cancelled, as a slow
// provider does, and remembers what it was given.
const seen = [];
globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
  seen.push({ url: String(url), signal: init.signal });
  if (init.signal?.aborted) return reject(init.signal.reason);
  init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
});
const client = await import('../src/lib/aiChat.js');
const ask = (o) => client.callAI({ apiKey: 'k', messages: [{ role: 'user', content: 'tidy this' }], systemPrompt: 'You tidy notes.', tools: [], ...o });

test('Cancel stops the request at the provider, with every provider', async () => {
  for (const o of [
    { provider: 'claude' },
    { provider: 'openai' },
    { provider: 'gemini' },
    { provider: 'oai-compat', baseUrl: 'http://127.0.0.1:9', model: 'local' },
  ]) {
    seen.length = 0;
    const stop = new AbortController();
    const asked = ask({ ...o, signal: stop.signal });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(seen.length, 1, `${o.provider}: one request out`);
    assert.equal(seen[0].signal, stop.signal, `${o.provider}: the request carries the signal`);
    stop.abort();
    await assert.rejects(asked, (e) => e.name === 'AbortError', `${o.provider}: cancelled, not an error to show`);
  }
});

test('Cancel stops the request through the server too (Trace set by the server, and the relay)', async () => {
  for (const [label, go] of [
    ['/api/ai/chat', (signal) => client.callAIProxy({ messages: [{ role: 'user', content: 'tidy' }], systemPrompt: 'x', signal })],
    ['/api/ai/relay', (signal) => ask({ provider: 'claude', relay: true, signal })],
  ]) {
    seen.length = 0;
    const stop = new AbortController();
    const asked = go(stop.signal);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(seen.length, 1, label);
    assert.match(seen[0].url, new RegExp(label.replace(/\//g, '\\/')), label);
    assert.equal(seen[0].signal, stop.signal, `${label}: carries the signal`);
    stop.abort();
    await assert.rejects(asked, (e) => e.name === 'AbortError', label);
  }
});

test('without a signal, Trace works as before', async () => {
  seen.length = 0;
  const asked = ask({ provider: 'claude' });
  asked.catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].signal, undefined);
});

// The server stops asking the provider once the app stops waiting
// (/api/ai/chat and /api/ai/relay). Needs the server's packages (CI).
let server = null, dir = null;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'notetrace-ask-close-'));
  process.env.DB_PATH = join(dir, 'test.db');
  server = await import('../server/routes/ai.js');
} catch { /* better-sqlite3 not built for this Node: the server half skips */ }
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test('the server stops asking the provider when the app stops waiting', { skip: !server && 'needs better-sqlite3' }, async () => {
  const res = () => Object.assign(new EventEmitter(), { writableFinished: false });
  const gone = res();
  const s1 = server._whileWaited(gone);
  assert.equal(s1.aborted, false);
  gone.emit('close');
  assert.equal(s1.aborted, true, 'the app went away before the answer: stop');
  const answered = res();
  const s2 = server._whileWaited(answered);
  answered.writableFinished = true;
  answered.emit('close');
  assert.equal(s2.aborted, false, 'closing after the answer is sent stops nothing');
  const s3 = server._whileWaited(res(), 20);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s3.aborted, true, 'the relay keeps its time limit');
  assert.equal(s3.reason?.name, 'TimeoutError');
  const src = read('../server/routes/ai.js');
  // Made first in each handler, so an app that leaves during the checks is caught.
  assert.match(src, /router\.post\('\/relay', requireAuth, aiRelayLimit, wrap\(async \(req, res\) => \{\n  const signal = _whileWaited\(res, 300_000\);/);
  assert.match(src, /router\.post\('\/chat', requireAuth, aiChatLimit, wrap\(async \(req, res\) => \{\n  const signal = _whileWaited\(res\);/, '/api/ai/chat gets no new time limit');
  assert.match(src, /const upstream = await fetch\(r\.url, \{ method: 'POST', headers: r\.headers, body: JSON\.stringify\(b\), signal \}\);/);
  for (const fn of ['_callClaude', '_callOpenAI', '_callGemini']) assert.match(src, new RegExp(`async function ${fn}\\([^)]*signal\\)`));
});
