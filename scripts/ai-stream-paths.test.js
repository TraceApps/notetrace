// Actual browser API + Express routes + a streaming inference stand-in.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

let mode = 'answer', disconnected = false;
const seen = [];
const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const body = JSON.parse(raw); seen.push(body);
    if (mode === 'fallback' && body.tools) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'this model does not support tools' } }));
    if (!body.stream || mode === 'json') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'Complete' }, finish_reason: 'stop' }] }));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': thinking\n\n');
    if (mode === 'silent') {
      res.on('close', () => { disconnected = true; });
      return;
    }
    res.write(chunk({ reasoning_content: 'never show this' }));
    res.write(chunk({ content: 'Com' }));
    if (mode === 'cut') return res.end();
    setTimeout(() => res.end(chunk({ content: 'plete' }) + chunk({}, mode === 'length' ? 'length' : 'stop') + 'data: [DONE]\n\n'), 30);
  });
});
await new Promise(r => endpoint.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${endpoint.address().port}`;
let db, server, base, dir, setupError;
try {
  const require = createRequire(new URL('../server/package.json', import.meta.url));
  require('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'ai-stream-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/ai', (await import('../server/routes/ai.js')).default);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const set = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of [['ai_provider', 'oai-compat'], ['ai_model', 'local'], ['ai_base_url', ENDPOINT]]) set.run(k, v);
} catch (e) { setupError = e; }

globalThis.BroadcastChannel = undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => originalFetch(typeof url === 'string' && url.startsWith('/') ? `${base}${url}` : url, init);
const { callAI, callAIProxy } = await import('../src/lib/aiChat.js');
const { readAIResponse } = await import('../src/lib/ai-stream.js');
const params = { provider: 'custom', model: 'local', baseUrl: ENDPOINT, messages: [{ role: 'user', content: 'table' }], systemPrompt: 'test' };
const limits = { maxTokens: 32768, contextSize: 262144 };
test.after(() => {
  globalThis.fetch = originalFetch;
  server?.closeAllConnections(); server?.close(); endpoint.closeAllConnections(); endpoint.close();
  db?.close(); if (dir) rmSync(dir, { recursive: true, force: true });
});

test('direct custom calls request SSE and deliver text before completion', async () => {
  mode = 'answer';
  let settled = false;
  const pieces = [];
  const promise = callAI({ ...params, tokenLimits: limits, onText: (text, reset) => { if (!reset) { assert.equal(settled, false); pieces.push(text); } } });
  assert.equal(await promise, 'Complete'); settled = true;
  assert.deepEqual(pieces, ['Com', 'plete']);
  assert.equal(seen.at(-1).stream, true);
  assert.equal(seen.at(-1).max_tokens, 32768);
});

test('real relay and editor proxy stream across both HTTP connections', async t => {
  if (!db) return t.skip(setupError?.message);
  mode = 'answer';
  const text = [];
  assert.equal(await callAI({ ...params, relay: true, tokenLimits: limits, onText: (s, reset) => { if (!reset) text.push(s); } }), 'Complete');
  assert.deepEqual(text, ['Com', 'plete']);
  assert.equal(seen.at(-1).stream, true);
  assert.equal(await callAIProxy({ ...params, tokenLimits: limits }), 'Complete');
  assert.equal(seen.at(-1).stream, true);
  assert.equal(seen.at(-1).max_tokens, 32768);
});

test('stream errors and exhaustion never return a partial editor rewrite', async t => {
  if (!db) return t.skip(setupError?.message);
  for (mode of ['cut', 'length']) {
    await assert.rejects(callAI({ ...params, relay: true, tokenLimits: limits }), mode === 'length' ? e => e.code === 'ai_tokens_output' : /before completion/);
    await assert.rejects(callAIProxy({ ...params, tokenLimits: limits }), mode === 'length' ? e => e.code === 'ai_tokens_output' : /before completion/);
  }
});

test('tool refusal is retried once and its metadata survives the streaming relay', async t => {
  if (!db) return t.skip(setupError?.message);
  mode = 'fallback';
  const notices = [];
  const start = seen.length;
  assert.equal(await callAI({ ...params, relay: true, tools: [{ name: 'search', parameters: { type: 'object' } }], onToolsUnsupported: info => notices.push(info) }), 'Complete');
  assert.equal(seen.length - start, 2);
  assert.equal(seen.at(-1).stream, true);
  assert.ok(!seen.at(-1).tools);
  assert.deepEqual(notices, [{ routed: false }]);
});

test('legacy relay clients still receive JSON; providers ignoring stream remain compatible', async t => {
  if (!db) return t.skip(setupError?.message);
  mode = 'answer';
  const res = await fetch(`${base}/api/ai/relay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: { messages: params.messages } }) });
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal((await res.json()).choices[0].message.content, 'Complete');
  assert.equal(seen.at(-1).stream, false);
  mode = 'json';
  assert.equal(await callAI({ ...params, relay: true }), 'Complete');
  assert.equal(await callAIProxy(params), 'Complete');
});

test('relay sends headers immediately and cancels inference when the browser disconnects', async t => {
  if (!db) return t.skip(setupError?.message);
  mode = 'silent'; disconnected = false;
  const start = seen.length;
  const res = await fetch(`${base}/api/ai/relay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: { stream: true, messages: params.messages } }) });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const reader = res.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
  for (let n = 0; n < 100 && seen.length === start; n++) await new Promise(r => setTimeout(r, 10));
  await reader.cancel();
  for (let n = 0; n < 100 && !disconnected; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(disconnected, true);
});

test('server transport keeps the browser alive while a provider is silent', async t => {
  if (!db) return t.skip(setupError?.message);
  mode = 'silent';
  const controller = new AbortController();
  const res = await fetch(`${base}/api/ai/chat`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, messages: params.messages }) });
  const reader = res.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
  // Exercise the actual 15-second server heartbeat, not a mocked timer.
  assert.match(new TextDecoder().decode((await reader.read()).value), /keep-alive/);
  controller.abort();
  await reader.cancel().catch(() => {});
});
