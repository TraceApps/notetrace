/**
 * A server that takes the connection and never answers (a captive portal, a
 * dead link, a host gone quiet behind a VPN) counts as no connection within
 * seconds, where the web app has an offline answer: the account kept on this
 * device opens, and the kept notes show. It used to wait on the browser,
 * minutes on end, with an empty page (src/lib/request-deadline.js).
 *
 * stores/auth.js and lib/api.js run here in Node (scripts/fixtures/auth-start)
 * with fetch answered per case; "hang" never answers.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  READ_MS, HEAVY_READ_MS, QUIET_READ_MS, SIGN_IN_CHECK_MS, QUIET_FOR_MS,
  deadlineSignal, startDeadline, fetchWithDeadline, isDeadlineError, noAnswerError, noteQuiet, noteAnswered, isQuiet, readDeadlineMs,
} from '../src/lib/request-deadline.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const SRC = new URL('../src/', import.meta.url).href;
let ready = true;
try { await import('svelte/store'); } catch { ready = false; }
const skip = (t) => { if (!ready) { t.skip('the app packages are missing'); return true; } return false; };

/** Runs `code` as the web app with the fixture, and returns what it printed after RESULT. */
function run(code, { store = {}, replies = {} } = {}) {
  // Node lets a process end with only a request's deadline left to wait for;
  // a page doesn't.
  code = 'setInterval(() => {}, 1000);\n' + code;
  const r = spawnSync(process.execPath, ['--import', new URL('./fixtures/auth-start/register.mjs', import.meta.url).href, '--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, AUTH_PHONE: '', AUTH_STORE: JSON.stringify(store), AUTH_REPLIES: JSON.stringify(replies) },
  });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  if (!line) throw new Error(`no result (timed out: ${r.error?.code === 'ETIMEDOUT'}):\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(7));
}

const ANN = { id: 7, username: 'ann', role: 'admin' };

test('a silent server, an account kept here: the app opens with it in seconds', (t) => {
  if (skip(t)) return;
  const res = run(`
const auth = await import(${JSON.stringify(SRC + 'stores/auth.js')});
const { get } = await import('svelte/store');
const t0 = Date.now();
await auth.loadAuthState();
console.log('RESULT ' + JSON.stringify({ ms: Date.now() - t0, user: get(auth.currentUser), unavailable: get(auth.authUnavailable) }));
process.exit(0);`, { store: { 'note:cachedUser': JSON.stringify(ANN), 'note:cachedUserMgmt': '1' }, replies: { '*': 'hang' } });
  assert.equal(res.user?.username, 'ann');
  assert.equal(res.unavailable, null);
  assert.ok(res.ms >= SIGN_IN_CHECK_MS - 100 && res.ms < SIGN_IN_CHECK_MS + 1500, `opened after ${res.ms} ms`);
});

test('a silent server: the kept notes answer in seconds, and the server counts as quiet', (t) => {
  if (skip(t)) return;
  // As the app opens: the sign-in check runs out first (an account kept
  // here), so the whole list, which may wait longer for a slow server,
  // only waits as long as a quiet server gets.
  const res = run(`
const auth = await import(${JSON.stringify(SRC + 'stores/auth.js')});
const { NoteApi } = await import(${JSON.stringify(SRC + 'lib/api.js')});
const deadline = await import(${JSON.stringify(SRC + 'lib/request-deadline.js')});
await auth.loadAuthState();
const t0 = Date.now();
const notes = await NoteApi.getNotes().catch(e => 'failed: ' + e.message);
console.log('RESULT ' + JSON.stringify({ ms: Date.now() - t0, notes, quiet: deadline.isQuiet() }));
process.exit(0);`, { store: { 'note:cachedUser': JSON.stringify(ANN), 'note:cachedUserMgmt': '1' }, replies: { '*': 'hang' } });
  assert.deepEqual(res.notes, [], 'the kept copy (empty here) answers, nothing fails');
  assert.ok(res.ms < QUIET_READ_MS + 1500, `answered after ${res.ms} ms`);
  assert.equal(res.quiet, true);
});

test('a slow server, not yet quiet: the whole list waits longer than a read', (t) => {
  if (skip(t)) return;
  const res = run(`
const { NoteApi } = await import(${JSON.stringify(SRC + 'lib/api.js')});
const t0 = Date.now();
const notes = await NoteApi.getNotes().catch(e => 'failed: ' + e.message);
console.log('RESULT ' + JSON.stringify({ ms: Date.now() - t0, notes }));
process.exit(0);`, { replies: { '*': 'hang' } });
  assert.deepEqual(res.notes, []);
  assert.ok(res.ms >= HEAVY_READ_MS - 100 && res.ms < HEAVY_READ_MS + 1500, `answered after ${res.ms} ms`);
});

test('a slow server, not quiet: a new note is sent with no deadline and waited for', (t) => {
  if (skip(t)) return;
  const res = run(`
const sent = [];
const real = globalThis.fetch;
globalThis.fetch = (url, init = {}) => { sent.push([init.method || 'GET', String(url), !!init.signal]); return real(url, init); };
const { NoteApi } = await import(${JSON.stringify(SRC + 'lib/api.js')});
const made = NoteApi.createNote({ title: 'Slow' }).then(() => 'answered', e => 'failed: ' + e.message);
const state = await Promise.race([made, new Promise(r => setTimeout(() => r('still waiting'), 6000))]);
console.log('RESULT ' + JSON.stringify({ state, posts: sent.filter(s => s[0] === 'POST') }));
process.exit(0);`, { replies: { '*': 'hang' } });
  assert.equal(res.state, 'still waiting', 'not cut off');
  assert.deepEqual(res.posts.map(p => [p[0], new URL(p[1], 'https://notes.example.com').pathname, p[2]]), [['POST', '/api/notes', false]], 'sent once, with no deadline');
});

test('reads stop waiting; a change that is sent waits as long as it takes', async (t) => {
  if (skip(t)) return;
  const { offlineDeadlineMs } = await import('../src/lib/offline-api.js');
  noteAnswered();
  for (const p of ['/api/notes/12', '/api/notes/counts?today=2026-10-27', '/api/notes/by-title?title=a', '/api/notes/12/backlinks', '/api/labels']) {
    assert.equal(offlineDeadlineMs('GET', p), READ_MS, p);
  }
  // The whole list, for a small server with many notes, gets longer.
  for (const p of ['/api/notes', '/api/notes?view=reminders', '/api/notes/titles']) assert.equal(offlineDeadlineMs('GET', p), HEAVY_READ_MS, p);
  for (const [m, p] of [['POST', '/api/notes'], ['PATCH', '/api/notes/12'], ['DELETE', '/api/notes/12'], ['POST', '/api/notes/12/restore'],
    ['POST', '/api/notes/12/items'], ['PATCH', '/api/notes/12/items/ab-12'], ['DELETE', '/api/notes/12/items/ab-12'], ['PUT', '/api/notes/12/items/order'],
    ['POST', '/api/notes/12/attachments'], ['POST', '/api/sync/push'], ['PUT', '/api/auth/profile']]) {
    // One cut off might have landed, and sent again it could be made twice.
    assert.equal(offlineDeadlineMs(m, p), null, `${m} ${p}`);
  }
  // Any other read answers as it does with no connection: it says so.
  // Trace's chat history is this server's own: a read like any other.
  for (const p of ['/api/notes/12/versions', '/api/app-config', '/api/ai/history']) assert.equal(offlineDeadlineMs('GET', p), READ_MS, p);
  // Server work with no offline answer waits as long as it takes, as before,
  // and so do reads the server answers by asking another service (a link's
  // preview waits up to 8 s on the other site) or that carry an account.
  for (const [m, p] of [['POST', '/api/notes/import'], ['POST', '/api/ai/chat'], ['POST', '/api/notes/12/versions/3/restore'],
    ['DELETE', '/api/notes/12/forever'], ['POST', '/api/notes/12/convert'], ['POST', '/api/full-backup/restore'], ['GET', '/api/integrations/cooktrace'],
    ['GET', '/api/link-preview?url=https%3A%2F%2Fexample.com'], ['GET', '/api/ai/models'], ['GET', '/api/upload/capabilities'],
    ['GET', '/api/updates/server-status'], ['GET', '/api/data/export'], ['GET', '/api/full-backup/x.zip/download'], ['GET', '/api/proxy?url=x']]) {
    assert.equal(offlineDeadlineMs(m, p), null, `${m} ${p}`);
  }
});

test('the api client gives offline reads a deadline, and leaves uploads alone', () => {
  const api = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8');
  assert.match(api, /\}, !isNative && !isUpload \? offlineDeadlineMs\(method, path\) : null\);/);
  assert.match(api, /const res = await fetchWithDeadline\(/);
  const offline = readFileSync(new URL('../src/lib/offline-api.js', import.meta.url), 'utf8');
  assert.match(offline, /const tried = !ops\.length && _online\(\) && !queueUnsent\(\);/, 'a quiet server: changes go to the outbox at once');
});

test('the deadline rules', () => {
  noteAnswered();
  assert.equal(readDeadlineMs(), READ_MS);
  const now = 1_000_000;
  noteQuiet(now);
  assert.equal(isQuiet(now + 1000), true);
  assert.equal(readDeadlineMs(now + 1000), QUIET_READ_MS);
  assert.equal(isQuiet(now + QUIET_FOR_MS), false, 'quiet only for a while');
  noteQuiet(now);
  noteAnswered();
  assert.equal(isQuiet(now + 1), false);

  // Only running out of time is no connection: the caller's own stop isn't.
  const timeout = new DOMException('The operation timed out.', 'TimeoutError');
  const e = noAnswerError(timeout, now);
  assert.equal(e.offline, true);
  assert.equal(isDeadlineError(e), true);
  assert.equal(isQuiet(now + 1), true);
  noteAnswered();
  const stopped = new DOMException('The operation was aborted.', 'AbortError');
  assert.equal(noAnswerError(stopped), stopped);
  assert.equal(isQuiet(), false);
  const dropped = new TypeError('Failed to fetch');
  assert.equal(noAnswerError(dropped), dropped);
});

test('a deadline keeps the caller\'s own signal', async () => {
  assert.equal(deadlineSignal(null), undefined);
  const own = new AbortController();
  assert.equal(deadlineSignal(0, own.signal), own.signal);
  const both = deadlineSignal(60_000, own.signal);
  own.abort();
  assert.equal(both.aborted, true);
  assert.equal(both.reason.name, 'AbortError');
  const timed = deadlineSignal(10);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(timed.aborted, true);
  assert.equal(timed.reason.name, 'TimeoutError');
});

test('the deadline is for the first answer: a long body still downloads', async () => {
  // Answered in time: the body is read long after the deadline would have run out.
  let seen;
  const res = await fetchWithDeadline(async (url, init) => { seen = init.signal; return 'answer'; }, '/api/notes', {}, 30);
  assert.equal(res, 'answer');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(seen.aborted, false, 'not aborted after the answer started');
  // No answer: stopped at the deadline, as no connection.
  noteAnswered();
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(fetchWithDeadline(hang, '/api/notes', {}, 20), (e) => e.offline === true && isDeadlineError(e));
  assert.equal(isQuiet(), true);
  noteAnswered();
  // The caller's own stop is passed on, and isn't no connection.
  const own = new AbortController();
  const stopped = fetchWithDeadline(hang, '/api/notes', { signal: own.signal }, 60_000);
  own.abort();
  await assert.rejects(stopped, (e) => e.name === 'AbortError' && !e.offline);
  assert.equal(isQuiet(), false);
  // No deadline: the caller's signal, untouched.
  assert.deepEqual(startDeadline(null, own.signal).signal, own.signal);
});
