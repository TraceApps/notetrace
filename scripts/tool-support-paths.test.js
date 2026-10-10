/**
 * Trace still answers when the model can't use tools (TraceApps/nutritrace#259).
 *
 * An OpenAI-compatible endpoint refused every request carrying `tools` for a
 * model without tool support, and Trace failed with the refusal. NoteTrace
 * sends tools from the app, directly (a personal setup) or through the
 * server's relay (Trace set by environment variables). Both run here against
 * a stand-in endpoint that refuses tools as the report shows.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { NO_TOOLS_NOTE } from '../src/lib/tool-support.js';

const upstream = { error_type: 'TOOL_USE_NOT_SUPPORTED', id: '2d1b4ad3-1622-4732-92b7-096410d39b1a', message: 'invalid request: tool use is not supported by the provided model: command-a-vision-07-2025' };
const REFUSAL = [400, { error: { message: `[400]: ${JSON.stringify(upstream)}` } }];
const reply = (message) => [200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message } }] }];
const toolless = (b) => (b.tools ? REFUSAL : reply({ content: 'Answer without tools.' }));
let answer = toolless;
const seen = [];
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    seen.push(body);
    const [status, data] = answer(body);
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  });
});
await new Promise(r => endpoint.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${endpoint.address().port}`;
const fresh = (fn) => { seen.length = 0; answer = fn; };
const toldNoTools = (body) => body.messages[0].role === 'system' && body.messages[0].content.endsWith(`\n\n${NO_TOOLS_NOTE}`);

// The server's relay, env-locked to the endpoint.
let db = null, dir = null, server = null, base = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'tool-support-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  const express = req('express');
  const { default: aiRoutes } = await import('../server/routes/ai.js');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/ai', aiRoutes);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
} catch { /* better-sqlite3 not built for this Node: the relay cases skip */ }
test.after(() => { server?.close(); endpoint.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

// The app's own AI calls, imported before any test is registered. Its
// offline layer opens a BroadcastChannel, which would keep this test
// running. The app asks for /api/... as a page at the server's address
// does: here those go to the test server.
globalThis.BroadcastChannel = undefined;
const _fetch = globalThis.fetch;
let appServer = null; // the server the app talks to, when not `base`
globalThis.fetch = (url, opts) => _fetch(typeof url === 'string' && url.startsWith('/') ? `${appServer || base}${url}` : url, opts);
const client = await import('../src/lib/aiChat.js');

const envLock = (model, provider = 'oai-compat') => {
  const set = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of [['ai_enabled', 'true'], ['ai_provider', provider], ['ai_base_url', ENDPOINT], ['ai_model', model], ['ai_api_key', 'sk-test'], ['ai_env_locked', 'true']]) set.run(k, v);
};
const TOOLS = [{ type: 'function', function: { name: 'search_notes', description: 'Search notes', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }];
const relay = async (body) => {
  const r = await fetch(`${base}/api/ai/relay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { messages: [{ role: 'system', content: 'You are Trace.' }, { role: 'user', content: 'Find my tomato note' }], tools: TOOLS, max_tokens: 4096, ...body } }),
  });
  return { status: r.status, body: await r.json() };
};

test('relay: a model that refuses tools answers without them, and the app is told', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('command-a-vision-07-2025');
  fresh(toolless);
  const r = await relay();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.choices[0].message.content, 'Answer without tools.');
  assert.equal(r.body.trace_tools_unsupported, true);
  assert.equal(r.body.trace_tools_routed, undefined);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].tools && !seen[1].tools);
  assert.ok(!toldNoTools(seen[0]) && toldNoTools(seen[1]), 'the retry tells the model no tools are available');

  fresh(toolless);
  const again = await relay();
  assert.equal(again.body.trace_tools_unsupported, true);
  assert.equal(seen.length, 1, 'the next message skips the doomed first attempt');
  assert.ok(toldNoTools(seen[0]));
});

test("relay: a combo model (the reporter's setup) is asked again without tools each time, and the app is told it was routed", async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('my-20-model-combo');
  for (let i = 0; i < 2; i++) {
    fresh(toolless);
    const r = await relay();
    assert.equal(r.status, 200);
    assert.equal(r.body.trace_tools_unsupported, true);
    assert.equal(r.body.trace_tools_routed, true);
    assert.equal(seen.length, 2, 'tools are offered again: the next pick may take them');
  }
});

test('app through the new relay: one retry in all, the answer arrives and Trace is told', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const viaRelay = (onToolsUnsupported) => client.callAI({
    provider: 'oai-compat', model: 'relay-model', relay: true,
    messages: [{ role: 'user', content: 'Find my tomato note' }], systemPrompt: 'You are Trace.',
    tools: client.TOOLS, onToolsUnsupported,
  });
  envLock('relay-toolless-model');
  fresh((b) => (b.tools ? [400, { error: { message: 'registry.ollama.ai/library/relay-toolless-model:latest does not support tools' } }] : reply({ content: 'Answer without tools.' })));
  const told = [];
  assert.equal(await viaRelay((i) => told.push(i)), 'Answer without tools.');
  assert.equal(seen.length, 2, 'the relay retried once; the app did not retry again');
  assert.ok(seen[0].tools && !seen[1].tools && toldNoTools(seen[1]));
  envLock('my-20-model-combo');
  fresh(toolless);
  assert.equal(await viaRelay((i) => told.push(i)), 'Answer without tools.');
  assert.deepEqual(told, [{ routed: false }, { routed: true }]);
});

test('app through an older relay (passes the refusal back): the app retries itself', async () => {
  // The relay as it was before: forwards the body and passes the answer back as it was.
  const old = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      const { body } = JSON.parse(raw);
      const r = await _fetch(`${ENDPOINT}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, model: 'old-relay-model', stream: false }) });
      res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(await r.text());
    });
  });
  await new Promise(r => old.listen(0, '127.0.0.1', r));
  appServer = `http://127.0.0.1:${old.address().port}`;
  try {
    fresh((b) => (b.tools ? [400, { error: { message: 'registry.ollama.ai/library/old-relay-model:latest does not support tools' } }] : reply({ content: 'Answer without tools.' })));
    const told = [];
    const r = await client.callAI({
      provider: 'oai-compat', model: 'old-relay-model', relay: true,
      messages: [{ role: 'user', content: 'Find my tomato note' }], systemPrompt: 'You are Trace.',
      tools: client.TOOLS, onToolsUnsupported: (i) => told.push(i),
    });
    assert.equal(r, 'Answer without tools.');
    assert.deepEqual(told, [{ routed: false }]);
    assert.equal(seen.length, 2);
    assert.ok(seen[0].tools && !seen[1].tools && toldNoTools(seen[1]));
  } finally {
    appServer = null;
    old.close();
  }
});

test('relay: an unrelated 400 is passed back as it was, after one request', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('model-with-a-small-context');
  const refusal = { error: { message: "This model's maximum context length is 8192 tokens.", code: 'context_length_exceeded' } };
  fresh(() => [400, refusal]);
  const r = await relay();
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, refusal);
  assert.equal(seen.length, 1);
});

test('relay: a model that takes tools still gets them, and the reply is passed back as it was', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('model-with-tools');
  const calls = reply({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{"q":"tomato"}' } }] });
  fresh((b) => (b.tools ? calls : REFUSAL));
  const r = await relay();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, calls[1]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tools[0].function.name, 'search_notes');
});

test('relay: a request without tools is sent once, as before', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('command-a-vision-07-2025');
  fresh(toolless);
  const r = await relay({ tools: undefined });
  assert.equal(r.status, 200);
  assert.equal(r.body.trace_tools_unsupported, undefined);
  assert.equal(seen.length, 1);
});

client.setToolHandler(async (name) => ({ ok: true, name }));
const direct = (model, onToolsUnsupported) => client.callAI({
  provider: 'oai-compat', baseUrl: ENDPOINT, model, apiKey: '',
  messages: [{ role: 'user', content: 'Find my tomato note' }], systemPrompt: 'You are Trace.',
  tools: client.TOOLS, onToolsUnsupported,
});

test('app: a model that refuses tools answers without them, and Trace is told', async () => {
  fresh(toolless);
  let told = 0;
  assert.equal(await direct('command-a-vision-07-2025', () => told++), 'Answer without tools.');
  assert.equal(told, 1);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].tools && !seen[1].tools && toldNoTools(seen[1]));

  fresh(toolless);
  assert.equal(await direct('command-a-vision-07-2025', () => told++), 'Answer without tools.');
  assert.equal(told, 2);
  assert.equal(seen.length, 1, 'the next message skips the doomed first attempt');
});

test('app: an unrelated 400 still fails, after one request', async () => {
  fresh(() => [400, { error: { message: 'Invalid API key format' } }]);
  await assert.rejects(direct('another-model'), /Invalid API key format/);
  assert.equal(seen.length, 1);
});

test('app: a model that takes tools still uses them', async () => {
  fresh((b) => (b.messages.some(m => m.role === 'tool')
    ? reply({ content: 'Found it.' })
    : reply({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{"q":"tomato"}' } }] })));
  let told = 0;
  assert.equal(await direct('model-with-tools', () => told++), 'Found it.');
  assert.equal(told, 0);
  assert.equal(seen.length, 2);
  assert.ok(seen.every(b => b.tools?.length));
});

test('app: a gateway that turns tool-less mid-answer gets the tool round as text', async () => {
  fresh((b) => (seen.length === 1
    ? reply({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{}' } }] })
    : toolless(b)));
  assert.equal(await direct('per-request-gateway'), 'Answer without tools.');
  assert.equal(seen.length, 3);
  assert.ok(seen[2].messages.every(m => m.role !== 'tool' && !m.tool_calls));
});

test('app: a combo model is asked again without tools, not remembered, and Trace is told it was routed', async () => {
  const told = [];
  for (let i = 0; i < 2; i++) {
    fresh(toolless);
    assert.equal(await direct('my-20-model-combo', (x) => told.push(x)), 'Answer without tools.');
    assert.equal(seen.length, 2);
  }
  assert.deepEqual(told, [{ routed: true }, { routed: true }]);
});

test('Trace adds the note once per conversation, in words for each setup, and never sends it', () => {
  const trace = readFileSync(new URL('../src/components/ai/Trace.svelte', import.meta.url), 'utf8');
  assert.match(trace, /tools: TOOLS,\n.*onToolCall.*\n\s*onToolsUnsupported,\n\s*\}\);/);
  assert.match(trace, /toolsNote = routed \? 'trace_ai_ct\.tools_unsupported_routed'\s*: aiEnvLocked \? 'trace_ai_ct\.tools_unsupported_server' : 'trace_ai_ct\.tools_unsupported';/);
  assert.match(trace, /messages = \[\.\.\.messages, \{ role: 'assistant', content: reply2, time: _fmtTime\(\) \}\];\s*if \(toolsNote\) messages = toolsNotice\.add\(messages, \$_\(toolsNote\)\);/);
  assert.match(trace, /messages = \[\];\s*toolsNotice\.reset\(\);/, 'a cleared chat is a new conversation');
  assert.match(trace, /const apiMessages = forModel\(messages\)/, 'the note is never sent to a model');
  assert.match(trace, /\{#if m\.role === 'note'\}\s*<div class="msg-note" role="status">/);
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  assert.match(en.trace_ai_ct.tools_unsupported, /Settings/);
  assert.match(en.trace_ai_ct.tools_unsupported_server, /admin/);
  assert.match(en.trace_ai_ct.tools_unsupported_routed, /no notes were searched or changed/);
});
