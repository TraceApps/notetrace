/**
 * Trace can go through all of a user's notes (TraceApps/notetrace#34).
 *
 * The report: "go through all my notes, find every license key" ended in
 * "Too many tool call rounds". Trace had 5 rounds of tool calls, search
 * returned at most 25 notes with no way to the next page, and get_note read
 * one note per call. Now search pages through every match and shows where
 * each matched, read_notes reads a batch in one call, Trace has 12 rounds,
 * and when they run out a last request with the tools off answers from what
 * was found and says what's left, instead of an error.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeNoteTool, matchSnippets, NOTE_TOOLS, sliceSafe } from '../server/lib/note-tools.js';
import { listView } from '../src/lib/offline-edits.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// The server half runs on a scratch database where better-sqlite3 is built (CI).
let server = null, dir = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'notetrace-trace-scan-'));
  process.env.DB_PATH = join(dir, 'test.db');
  server = {
    db: (await import('../server/db.js')).default,
    Notes: await import('../server/lib/notes.js'),
    ai: await import('../server/routes/ai.js'),
    mcp: await import('../server/lib/mcp/tools/notes.js'),
    z: req('zod').z,
  };
} catch { /* better-sqlite3 not built for this Node: the server half skips */ }
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

// ── The note tools ──────────────────────────────────────────────────────
function fakeApi(notes) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const clone = (n) => JSON.parse(JSON.stringify(n));
  return {
    async getLabels() { return []; },
    async getNotes({ q = '' } = {}) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      return notes.filter((n) => words.every((w) => `${n.title} ${n.body_md} ${(n.items || []).map((i) => i.text).join(' ')}`.toLowerCase().includes(w))).map(clone);
    },
    async getNote(id) { return byId.has(id) ? clone(byId.get(id)) : null; },
  };
}
const note = (id, title, body_md, extra = {}) => ({ id, title, body_md, kind: 'text', items: [], labels: [], pinned: false, archived: false, reminder_at: null, share_role: 'owner', ...extra });

test('search pages through every match, with a count and where the next page starts', async () => {
  const notes = Array.from({ length: 60 }, (_, i) => note(i + 1, `Software ${i + 1}`, `Product ${i + 1}\nLicense key: KEY-${1000 + i}`));
  notes.push(note(99, 'Groceries', 'milk, eggs'));
  const api = fakeApi(notes);
  const first = await executeNoteTool('search_notes', { query: 'license', limit: 25 }, api);
  assert.deepEqual([first.count, first.offset, first.returned, first.next_offset, first.complete], [60, 0, 25, 25, false]);
  assert.equal(first.more, 'This is notes 1 to 25 of 60: call search_notes again with offset 25 for the rest.');
  const seen = new Set(first.notes.map((n) => n.id));
  let page = first;
  while (!page.complete) {
    page = await executeNoteTool('search_notes', { query: 'license', limit: 25, offset: page.next_offset }, api);
    page.notes.forEach((n) => seen.add(n.id));
  }
  assert.equal(seen.size, 60, 'every match, once');
  assert.deepEqual([page.offset, page.returned, page.next_offset, page.complete], [50, 10, null, true]);
  assert.equal(page.more, undefined, 'the last page says nothing more');
  // Up to 50 a page; past the end, an empty last page.
  assert.equal((await executeNoteTool('search_notes', { query: 'license', limit: 500 }, api)).returned, 50);
  assert.deepEqual((await executeNoteTool('search_notes', { query: 'license', offset: 999 }, api)).notes, []);
  // Without a query, every note: the whole collection, page by page.
  const all = await executeNoteTool('search_notes', { limit: 50 }, api);
  assert.deepEqual([all.count, all.returned, all.next_offset], [61, 50, 50]);
  assert.equal(all.notes[0].matches, undefined);
  // The default stays 10, and count still means every match.
  const plain = await executeNoteTool('search_notes', { query: 'license' }, api);
  assert.deepEqual([plain.count, plain.returned], [60, 10]);
});

test('each match shows where the note says it, accents and case aside', async () => {
  const api = fakeApi([note(1, 'Office', `Bought Microsoft Office in 2024.\n\nLicense key: ABCD-EFGH-1234\n${'x'.repeat(300)}\nSecond license for the laptop: WXYZ-9876`)]);
  const r = await executeNoteTool('search_notes', { query: 'license' }, api);
  assert.equal(r.notes[0].matches.length, 2);
  assert.match(r.notes[0].matches[0], /License key: ABCD-EFGH-1234/);
  assert.match(r.notes[0].matches[1], /Second license for the laptop: WXYZ-9876/);
  // Folded matching, cut from the original text (ß folds to two letters).
  assert.deepEqual(matchSnippets(note(2, 'Trip', 'Hotel an der Hauptstraße 5, Café Müller'), 'strasse cafe'), ['Trip Hotel an der Hauptstraße 5, Café Müller']);
  const long = note(3, 'T', `${'a '.repeat(100)}Straße${' b'.repeat(100)}`);
  const [cut] = matchSnippets(long, 'STRASSE');
  assert.match(cut, /^….*Straße.*…$/);
  assert.ok(cut.length < 150);
  // A checklist matches on its items.
  assert.deepEqual(matchSnippets({ id: 4, title: 'Keys', kind: 'checklist', items: [{ text: 'Windows license XXXX' }, { text: 'milk' }] }, 'license'), ['Keys Windows license XXXX milk']);
  assert.deepEqual(matchSnippets(note(5, 'a', 'b'), ''), []);
  // Words split as the search splits them: a key with a dash still matches.
  assert.match(matchSnippets(note(6, 'Win', 'Key ABCD-1234 for the desktop'), 'abcd-1234')[0], /Key ABCD-1234 for the desktop/);
  // Greek: accents and the word-final sigma fold like the search does.
  assert.deepEqual(matchSnippets(note(7, 'Σημείωση', 'Ο κωδικός μου'), 'ΚΩΔΙΚΟΣ'), ['Σημείωση Ο κωδικός μου']);
  // Image text and voice note transcripts are searched, so passages come from them too.
  assert.match(matchSnippets(note(8, 'Receipt', '', { attachments: [{ mime: 'image/png', extracted_text: 'Serial number: SN-9988' }] }), 'serial')[0], /Serial number: SN-9988/);
  // A common word can't use up the passages: the rarer word gets one.
  const common = matchSnippets(note(9, 'Log', `${`the ${'x'.repeat(200)} `.repeat(10)}Finally, license: KEY-77`), 'the license');
  assert.equal(common.length, 3);
  assert.ok(common.some((p) => /license: KEY-77/.test(p)), JSON.stringify(common));
  // Close hits share one passage, which never grows past 240 characters, and
  // a hit past that starts the next passage instead of going missing.
  const dense = matchSnippets(note(10, 'T', `${'key '.repeat(200)}`), 'key');
  assert.ok(dense.every((p) => p.length <= 240 + 2), JSON.stringify(dense.map((p) => p.length)));
  const pair = matchSnippets(note(11, 'T', `${'x'.repeat(100)} alpha ${'y'.repeat(150)} omega ${'z'.repeat(100)}`), 'alpha omega');
  assert.equal(pair.length, 2);
  assert.match(pair[0], /alpha/);
  assert.match(pair[1], /omega/);
  // An emoji at a cut is kept whole or left out, never half of it.
  const emoji = matchSnippets(note(12, 'T', `${'😀'.repeat(60)}needle${'😀'.repeat(60)}`), 'needle')[0];
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  assert.equal(sliceSafe('ab😀cd', 0, 3), 'ab');
  assert.equal(sliceSafe('ab😀cd', 3), '😀cd');
  assert.equal(sliceSafe('abcd', 1, 3), 'bc');
});

test('read_notes reads a batch in full, within what one answer holds', async () => {
  const notes = Array.from({ length: 30 }, (_, i) => note(i + 1, `N${i + 1}`, `key ${i + 1}`));
  const api = fakeApi(notes);
  const ids = notes.map((n) => n.id);
  const r = await executeNoteTool('read_notes', { ids }, api);
  assert.equal(r.notes.length, 25);
  assert.deepEqual(r.not_read, [26, 27, 28, 29, 30]);
  assert.equal(r.notes[0].text, 'key 1');
  assert.match(r.more, /another read_notes call/);
  // Long notes: the text is cut at 8,000 characters and marked; the answer
  // stays within 16,000 characters of JSON and the rest wait, in order.
  const big = fakeApi([note(1, 'A', 'a'.repeat(15000)), note(2, 'B', 'b'.repeat(15000)), note(3, 'C', 'c'), note(4, 'D', 'd')]);
  const b = await executeNoteTool('read_notes', { ids: [1, 2, 3, 4] }, big);
  assert.match(b.notes[0].text, /^a{8000}\n…\(truncated\)$/);
  assert.deepEqual([b.notes.map((n) => n.id), b.not_read], [[1], [2, 3, 4]]);
  assert.ok(JSON.stringify(b.notes).length <= 16000);
  // Everything counts toward the size: items, image text, transcripts.
  const list = { ...note(5, 'Inventory', ''), kind: 'checklist', items: Array.from({ length: 900 }, (_, i) => ({ text: `Serial ${i}: ${'s'.repeat(20)}`, checked: false })) };
  const scans = note(6, 'Scans', 'short', { attachments: [{ mime: 'image/png', extracted_text: 't'.repeat(9000) }, { mime: 'audio/webm', extracted_text: 'v'.repeat(9000) }] });
  const heavy = fakeApi([list, scans, note(7, 'Small', 'tiny')]);
  // A note too big for any call says so, and the rest of the batch is still read.
  const h = await executeNoteTool('read_notes', { ids: [5, 7] }, heavy);
  assert.deepEqual(h.notes[0], { id: 5, title: 'Inventory', kind: 'checklist', too_long: 'Too long to read along with others: read it with get_note.' });
  assert.equal(h.notes[1].text, 'tiny');
  // Behind others, it waits for the next call, where it comes first.
  const h2 = await executeNoteTool('read_notes', { ids: [7, 6, 5] }, heavy);
  assert.deepEqual([h2.notes.map((n) => n.id), h2.not_read], [[7], [6, 5]]);
  assert.ok(JSON.stringify(h2).length < 17000);
  // Ids it doesn't know, the same id twice, none at all.
  const odd = await executeNoteTool('read_notes', { ids: [1, 1, 777] }, api);
  assert.deepEqual([odd.notes.map((n) => n.id), odd.not_found], [[1], [777]]);
  assert.match((await executeNoteTool('read_notes', { ids: [] }, api)).error, /ids is required/);
  // On the web getNote throws for a note that's gone: that note is not found, the batch still reads.
  const gone = Object.assign(new Error('Note not found'), { status: 404 });
  const web = { ...api, async getNote(id) { if (id === 3) throw gone; return api.getNote(id); } };
  const w = await executeNoteTool('read_notes', { ids: [1, 3, 2] }, web);
  assert.deepEqual([w.notes.map((n) => n.id), w.not_found, w.failed], [[1, 2], [3], undefined]);
  // Offline and not on this device, or the server down: the note may be there, and Trace is told so.
  const offline = Object.assign(new Error('This needs a connection'), { offline: true });
  const down = Object.assign(new Error('API error 502'), { status: 502 });
  const flaky = { ...api, async getNote(id) { if (id === 3) throw offline; if (id === 4) throw down; return api.getNote(id); } };
  const f = await executeNoteTool('read_notes', { ids: [1, 3, 4, 2] }, flaky);
  assert.deepEqual([f.notes.map((n) => n.id), f.not_found, f.failed], [[1, 2], undefined, [{ id: 3, error: 'This needs a connection' }, { id: 4, error: 'API error 502' }]]);
});

test('the same list comes in the same order every time, so pages never skip or repeat a note', () => {
  // Notes imported together share a time: the id settles the order.
  for (const f of ['../server/lib/notes.js', '../src/lib/notes-native.js']) {
    const src = read(f);
    assert.match(src, /DESC, n\.updated_at DESC, n\.id DESC'?`?\n\s*: view === 'reminders' \? 'n\.reminder_at ASC, n\.id DESC'\n\s*: 'n\.updated_at DESC, n\.id DESC'/, f);
  }
  // Offline, the list from the notes kept on the device goes the same way.
  const at = '2026-10-01T10:00:00.000Z';
  const local = [3, 1, 2].map((id) => ({ id, title: `N${id}`, updated_at: at, reminder_at: at }));
  assert.deepEqual(listView(local).map((n) => n.id), [3, 2, 1]);
  assert.deepEqual(listView(local, { view: 'reminders' }).map((n) => n.id), [3, 2, 1]);
  assert.deepEqual(listView(local, { view: 'archive' }).map((n) => n.id), []);
});

test('on the server, notes saved at the same moment list newest id first, searched or not', { skip: !server && 'needs better-sqlite3' }, () => {
  const { db, Notes } = server;
  const ids = [1, 2, 3, 4].map((i) => Notes.createNote(null, { title: `License ${i}`, body_md: `key ${i}` }).id);
  db.prepare('UPDATE notes SET updated_at = ?').run('2026-10-01 10:00:00');
  const want = [...ids].reverse();
  assert.deepEqual(Notes.listNotes(null).map((n) => n.id), want);
  assert.deepEqual(Notes.listNotes(null, { q: 'license' }).map((n) => n.id), want);
  // Paging through it with the tool: each note once.
  const api = server.mcp.notesApiFor(null);
  return (async () => {
    const seen = [];
    for (let offset = 0; offset != null;) {
      const page = await executeNoteTool('search_notes', { query: 'license', limit: 3, offset }, api);
      seen.push(...page.notes.map((n) => n.id));
      offset = page.next_offset;
    }
    assert.deepEqual(seen, want);
    // A note that isn't there is not found, through the server's own notes layer too.
    const r = await executeNoteTool('read_notes', { ids: [ids[0], 99999] }, api);
    assert.deepEqual([r.notes.map((n) => n.id), r.not_found], [[ids[0]], [99999]]);
  })();
});

test('the relay passes the last request on as the app built it', { skip: !server && 'needs better-sqlite3' }, () => {
  const { relayRequest } = server.ai;
  assert.deepEqual(relayRequest({ provider: 'claude', model: 'm' }, { messages: [], tools: [{}], tool_choice: { type: 'none' } }).body.tool_choice, { type: 'none' });
  assert.equal(relayRequest({ provider: 'openai', model: 'm' }, { messages: [], tools: [{}], tool_choice: 'none' }).body.tool_choice, 'none');
  assert.deepEqual(relayRequest({ provider: 'gemini', model: 'm' }, { contents: [], tools: [{}], toolConfig: { functionCallingConfig: { mode: 'NONE' } } }).body.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
});

test('MCP takes read_notes ids as numbers', { skip: !server && 'needs better-sqlite3' }, () => {
  const { mcp, z } = server;
  const schema = z.object(mcp.inputShape(NOTE_TOOLS.find((t) => t.name === 'read_notes')));
  assert.deepEqual(schema.parse({ ids: [1, 2] }), { ids: [1, 2] });
  assert.throws(() => schema.parse({ ids: ['1'] }));
  assert.throws(() => schema.parse({}));
});

test('the server relay allows the requests a long scan makes', () => {
  // 13 requests a scan, more with the length and tools fallbacks: the relay has its own, larger limit.
  const src = read('../server/routes/ai.js');
  assert.match(src, /const aiRelayLimit = makeRateLimiter\(\{ max: 60, windowMs: 60_000, label: 'ai-relay' \}\);/);
  assert.match(src, /router\.post\('\/relay', requireAuth, aiRelayLimit,/);
  assert.match(src, /router\.post\('\/chat', requireAuth, aiChatLimit,/);
});

test('MCP offers read_notes as a read tool and takes its ids as numbers', () => {
  const mcp = read('../server/lib/mcp/tools/notes.js');
  assert.match(mcp, /export const READ = \['search_notes', 'get_note', 'read_notes',/);
  assert.match(mcp, /prop\.items\?\.type === 'integer' \? z\.number\(\)\.int\(\) : z\.string\(\)\.max\(5000\)/);
  const tool = NOTE_TOOLS.find((t) => t.name === 'read_notes');
  assert.deepEqual(tool.parameters.properties.ids.items, { type: 'integer' });
  assert.deepEqual(NOTE_TOOLS.find((t) => t.name === 'search_notes').parameters.properties.offset.type, 'integer');
  // Trace doesn't refresh the notes list for a read.
  assert.match(read('../src/components/ai/Trace.svelte'), /\['search_notes', 'get_note', 'read_notes', 'list_labels'/);
});

// ── Trace's rounds, against a stand-in provider ─────────────────────────
// Each provider asks for a tool until its request turns the tools off (or
// until `stopAfter` rounds), then answers. `rejectChoice`: an OpenAI-
// compatible server that refuses tool_choice; `ignoreChoice`: one that
// ignores it and asks for a tool anyway, with no text.
let stopAfter = Infinity, rejectChoice = false, rejectStatus = 400, ignoreChoice = false, perRound = 1, argPad = '';
const seen = [];
const toolRounds = (b, path) => (path.startsWith('/claude')
  ? (b.messages || []).filter((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')).length
  : path.startsWith('/gemini')
    ? (b.contents || []).filter((c) => c.parts?.some((p) => p.functionResponse)).length
    : (b.messages || []).filter((m) => m.role === 'tool').length);
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const b = JSON.parse(raw || '{}');
    seen.push({ path: req.url, body: b });
    const n = toolRounds(b, req.url);
    let out;
    if (req.url.startsWith('/claude')) {
      out = b.tool_choice?.type === 'none' || n >= stopAfter
        ? { content: [{ type: 'text', text: `answer after ${n}` }], stop_reason: 'end_turn' }
        : { content: Array.from({ length: perRound }, (_, k) => ({ type: 'tool_use', id: `t${n}_${k}`, name: 'search_notes', input: { query: 'license', offset: n * 25, ...(argPad ? { pad: argPad } : {}) } })), stop_reason: 'tool_use' };
    } else if (req.url.startsWith('/gemini')) {
      out = b.toolConfig?.functionCallingConfig?.mode === 'NONE' || n >= stopAfter
        ? { candidates: [{ content: { parts: [{ text: `answer after ${n}` }] }, finishReason: 'STOP' }] }
        : { candidates: [{ content: { parts: Array.from({ length: perRound }, () => ({ functionCall: { name: 'search_notes', args: { query: 'license', ...(argPad ? { pad: argPad } : {}) } } })) }, finishReason: 'STOP' }] };
    } else {
      if (rejectChoice && b.tool_choice) return res.writeHead(rejectStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: "Unsupported value: 'tool_choice' none" } }));
      const answer = (b.tool_choice === 'none' && !ignoreChoice) || n >= stopAfter;
      out = { choices: [{ index: 0, finish_reason: answer ? 'stop' : 'tool_calls', message: answer
        ? { role: 'assistant', content: `answer after ${n}` }
        : { role: 'assistant', content: null, tool_calls: Array.from({ length: perRound }, (_, k) => ({ id: `c${n}_${k}`, type: 'function', function: { name: 'search_notes', arguments: JSON.stringify({ query: 'license', ...(argPad ? { pad: argPad } : {}) }) } })) } }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
  });
});
await new Promise((r) => endpoint.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${endpoint.address().port}`;
test.after(() => endpoint.close());
const _fetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.anthropic.com')) return _fetch(`${ENDPOINT}/claude`, opts);
  if (u.startsWith('https://generativelanguage.googleapis.com')) return _fetch(`${ENDPOINT}/gemini`, opts);
  return _fetch(url, opts);
};
const client = await import('../src/lib/aiChat.js');
let calls = 0, toolResult = { count: 0, notes: [] };
client.setToolHandler(async () => { calls++; return toolResult; });
const TOOLS = [NOTE_TOOLS.find((t) => t.name === 'search_notes')];
const fresh = (o = {}) => { seen.length = 0; calls = 0; stopAfter = o.stopAfter ?? Infinity; rejectChoice = !!o.rejectChoice; rejectStatus = o.rejectStatus ?? 400; ignoreChoice = !!o.ignoreChoice; toolResult = o.toolResult ?? { count: 0, notes: [] }; perRound = o.perRound ?? 1; argPad = o.argPad ?? ''; };
const ask = (provider) => client.callAI({
  provider, apiKey: 'k', model: provider === 'oai-compat' ? 'local' : undefined, baseUrl: provider === 'oai-compat' ? ENDPOINT : undefined,
  messages: [{ role: 'user', content: 'Find every license key in my notes.' }], systemPrompt: 'You are Trace.', tools: TOOLS,
});

test('12 rounds of tool calls: a scan that needs 8 finishes', async () => {
  assert.equal(client.TOOL_ROUNDS, 12);
  for (const provider of ['oai-compat', 'claude', 'gemini']) {
    fresh({ stopAfter: 8 });
    assert.equal(await ask(provider), 'answer after 8', provider);
    assert.equal(calls, 8);
  }
  assert.doesNotMatch(read('../src/lib/aiChat.js'), /Too many tool call rounds|MAX_ROUNDS = 5/);
});

test('out of rounds, a last request with the tools off answers from what was found', async () => {
  for (const provider of ['oai-compat', 'claude', 'gemini']) {
    fresh();
    assert.equal(await ask(provider), 'answer after 12', provider);
    assert.equal(calls, 12, `${provider}: 12 rounds of tools`);
    assert.equal(seen.length, 13);
    const last = seen[12].body;
    const system = provider === 'oai-compat' ? last.messages[0].content : provider === 'claude' ? last.system : last.systemInstruction.parts[0].text;
    assert.ok(system.startsWith('You are Trace.') && system.endsWith(client.OUT_OF_ROUNDS), `${provider}: told to answer in the system prompt`);
    // Only the last request is: the rounds before go as they always did.
    const before = seen[11].body;
    assert.equal(provider === 'oai-compat' ? before.messages[0].content : provider === 'claude' ? before.system : before.systemInstruction.parts[0].text, 'You are Trace.');
    if (provider === 'oai-compat') { assert.equal(last.tool_choice, 'none'); assert.ok(last.tools?.length); assert.equal(before.tool_choice, undefined); }
    if (provider === 'claude') { assert.deepEqual(last.tool_choice, { type: 'none' }); assert.ok(last.tools?.length); assert.equal(before.tool_choice, undefined); }
    if (provider === 'gemini') { assert.deepEqual(last.toolConfig, { functionCallingConfig: { mode: 'NONE' } }); assert.equal(before.toolConfig, undefined); }
    // The conversation itself isn't changed: the last message is the tool results.
    if (provider === 'oai-compat') assert.equal(last.messages.at(-1).role, 'tool');
    if (provider === 'claude') assert.equal(last.messages.at(-1).content[0].type, 'tool_result');
    if (provider === 'gemini') assert.ok(last.contents.at(-1).parts[0].functionResponse);
  }
});

test('a server that refuses tool_choice is asked once more without it; one that ignores it still gets an answer said', async () => {
  fresh({ rejectChoice: true, stopAfter: 99 });
  // The 13th request is refused for tool_choice, and asked again without it.
  const r = await ask('oai-compat');
  assert.equal(seen.length, 14);
  assert.equal(seen[12].body.tool_choice, 'none');
  assert.equal(seen[13].body.tool_choice, undefined);
  assert.ok(seen[13].body.messages[0].content.endsWith(client.OUT_OF_ROUNDS));
  // That server then asked for a tool again with no text: Trace says why there's no answer.
  assert.match(r, /more steps than one answer allows/);
  fresh({ ignoreChoice: true });
  assert.match(await ask('oai-compat'), /more steps than one answer allows/);
  assert.equal(calls, 12, 'and runs no 13th round of tools');
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.match(en.trace_reply.out_of_rounds, /more steps than one answer allows/);
  // 422 is a refusal too; any other failure is the error it always was, not asked again.
  fresh({ rejectChoice: true, rejectStatus: 422, stopAfter: 99 });
  await ask('oai-compat');
  assert.equal(seen.length, 14);
  fresh({ rejectChoice: true, rejectStatus: 503, stopAfter: 99 });
  await assert.rejects(ask('oai-compat'), /Unsupported value/);
  assert.equal(seen.length, 13);
});

test('a conversation that gets too big wraps up early the same way', async () => {
  assert.equal(client.HISTORY_MAX_BYTES, 300000);
  for (const provider of ['oai-compat', 'claude', 'gemini']) {
    // Each tool answer is 200 kB: after two, the next request is the last.
    fresh({ toolResult: { notes: [{ text: 'x'.repeat(200000) }] } });
    assert.equal(await ask(provider), 'answer after 2', provider);
    assert.equal(calls, 2, provider);
    assert.equal(seen.length, 3, provider);
    const [first, second, last] = seen.map((s) => s.body);
    if (provider === 'gemini') {
      assert.deepEqual(last.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
      assert.equal(second.toolConfig, undefined);
    } else {
      assert.ok(last.tool_choice, provider);
      assert.equal(second.tool_choice, undefined, provider);
    }
    assert.equal(first.tool_choice ?? first.toolConfig, undefined, provider);
    // Under what the relay takes (1 MB).
    assert.ok(Buffer.byteLength(JSON.stringify(last)) < 1_000_000);
  }
  // Many calls at once can't pass it by much: once one round's answers are
  // over, the rest of that round's calls aren't run, and say why.
  for (const provider of ['oai-compat', 'claude', 'gemini']) {
    fresh({ perRound: 4, toolResult: { notes: [{ text: 'x'.repeat(300000) }] } });
    await ask(provider);
    assert.equal(calls, 1, `${provider}: one ran, three didn't`);
    assert.equal(seen.length, 2, provider);
    const last = seen[1].body;
    const body = JSON.stringify(last);
    assert.equal(body.split(client.TOOL_SKIPPED).length - 1, 3, `${provider}: each call left unrun still has its answer`);
    if (provider === 'gemini') assert.deepEqual(last.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
    else assert.ok(last.tool_choice, provider);
    assert.ok(Buffer.byteLength(body) < 1_000_000, `${provider}: under what the relay takes`);
  }
  // What the model itself sent (a long note it wrote) doesn't use up a
  // round's room: only the answers do, so calls it already paid for still run.
  for (const provider of ['oai-compat', 'claude', 'gemini']) {
    fresh({ perRound: 4, argPad: 'w'.repeat(100000), stopAfter: 1 });
    await ask(provider);
    assert.equal(calls, 4, `${provider}: every call ran`);
    assert.ok(!JSON.stringify(seen.at(-1).body).includes(client.TOOL_SKIPPED), provider);
  }
  // A photo the user attached doesn't count: only what the tools add does.
  for (const provider of ['oai-compat', 'claude', 'gemini']) {
    fresh({ stopAfter: 4 });
    const photo = { base64: 'A'.repeat(2_000_000), mimeType: 'image/jpeg' };
    const r = await client.callAI({
      provider, apiKey: 'k', model: provider === 'oai-compat' ? 'local' : undefined, baseUrl: provider === 'oai-compat' ? ENDPOINT : undefined,
      messages: [{ role: 'user', content: 'Add the items in this photo to my Groceries list.', _image: photo }], systemPrompt: 'You are Trace.', tools: TOOLS,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(seen[0].body)) > 2_000_000, `${provider}: the photo went with the question`);
    assert.equal(r, 'answer after 4', provider);
    assert.equal(calls, 4, `${provider}: every round the answer needed`);
  }
  // Japanese counts by its bytes, not its characters.
  fresh({ toolResult: { notes: [{ text: 'あ'.repeat(70000) }] } });
  await ask('claude');
  assert.equal(calls, 2, '70,000 characters of Japanese are 210 kB');
});

test('Trace is told how to go through many notes', () => {
  assert.match(read('../src/components/ai/Trace.svelte'), /page through search_notes with offset until complete is true[^`]*read the notes you need with read_notes in batches, and say whether you covered everything/);
});
