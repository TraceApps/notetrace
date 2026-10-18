// Reproduce #23 against a stand-in inference endpoint, through the actual
// browser client, environment-locked editor proxy, and tool relay.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const seen = [];
let mode = 'answer';
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    seen.push(JSON.parse(raw));
    const message = mode === 'reasoning' ? { content: null, reasoning_content: 'Still thinking' } : { content: mode === 'length' ? 'Partial table' : 'Complete table' };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message, finish_reason: mode === 'length' ? 'length' : 'stop' }] }));
  });
});
await new Promise(r => endpoint.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${endpoint.address().port}`;

let db, dir, server, base;
try {
  const require = createRequire(new URL('../server/package.json', import.meta.url));
  require('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'ai-tokens-'));
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
  for (const [key, value] of [['ai_provider', 'oai-compat'], ['ai_model', 'local'], ['ai_base_url', ENDPOINT]]) set.run(key, value);
} catch { /* Native SQLite unavailable: the HTTP proxy tests skip. */ }

test.after(() => { server?.close(); endpoint.close(); db?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
globalThis.BroadcastChannel = undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => originalFetch(typeof url === 'string' && url.startsWith('/') ? `${base}${url}` : url, init);
const { callAI, callAIProxy } = await import('../src/lib/aiChat.js');
const params = { provider: 'custom', model: 'local', baseUrl: ENDPOINT, messages: [{ role: 'user', content: 'Make a detailed table.' }], systemPrompt: 'Return only the table.' };
const limits = { maxTokens: 32768, contextSize: 262144 };

test('direct custom calls honor output limits above 4096 without sending context/minimum fields', async () => {
  mode = 'answer';
  assert.equal(await callAI({ ...params, tokenLimits: limits }), 'Complete table');
  assert.equal(seen.at(-1).max_tokens, 32768);
  for (const key of ['min_tokens', 'contextSize', 'tokenLimits']) assert.ok(!(key in seen.at(-1)));
  await callAI(params);
  assert.equal(seen.at(-1).max_tokens, 16384);
});

test('client explains token exhaustion and reasoning-only replies', async () => {
  for (const [m, code] of [['length', 'output'], ['reasoning', 'reasoning']]) {
    mode = m;
    await assert.rejects(callAI({ ...params, tokenLimits: limits }), e => e.code === `ai_tokens_${code}`);
  }
});

test('the environment-locked editor proxy honors the same limits, not its old 1024 cap', async t => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  mode = 'answer';
  assert.equal(await callAIProxy({ ...params, tokenLimits: limits }), 'Complete table');
  assert.equal(seen.at(-1).max_tokens, 32768);
  mode = 'length';
  await assert.rejects(callAIProxy({ ...params, tokenLimits: limits }), e => e.code === 'ai_tokens_output');
});

test('relay honors limits above 8192 and refuses values above the admin ceiling', async t => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  mode = 'answer';
  assert.equal(await callAI({ ...params, relay: true, tokenLimits: limits }), 'Complete table');
  assert.equal(seen.at(-1).max_tokens, 32768);
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)').run('ai_max_tokens', '16384');
  const count = seen.length;
  await assert.rejects(callAI({ ...params, relay: true, tokenLimits: limits }), e => e.code === 'ai_tokens_server');
  await assert.rejects(callAIProxy({ ...params, tokenLimits: limits }), e => e.code === 'ai_tokens_server');
  assert.equal(seen.length, count, 'rejected before calling the inference server');
});
