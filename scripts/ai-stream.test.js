import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { readAIResponse, fetchAIResponse } from '../src/lib/ai-stream.js';
import { openAIAnswer } from '../src/lib/ai-token-limits.js';

const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
const end = reason => event({}, reason) + 'data: [DONE]\r\n\r\n';
function response(text, split = false) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(c) {
    if (split) for (const b of bytes) c.enqueue(Uint8Array.of(b));
    else c.enqueue(bytes);
    c.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('stream helpers are identical on client and server', () => {
  assert.equal(readFileSync(new URL('../src/lib/ai-stream.js', import.meta.url), 'utf8'), readFileSync(new URL('../server/lib/ai-stream.js', import.meta.url), 'utf8'));
});

test('SSE decodes UTF-8 and CRLF split at every byte, comments and multiline data', async () => {
  const pieces = [];
  const raw = ': thinking\r\n\r\n' + event({ reasoning_content: 'private' })
    + 'data: {"choices":\r\ndata: [{"index":0,"delta":{"content":"Hi 🌍"},"finish_reason":null}]}\r\n\r\n'
    + event({ content: '!' }) + end('stop');
  const r = await readAIResponse(response(raw, true), { onText: text => pieces.push(text) });
  assert.equal(openAIAnswer(r.data).content, 'Hi 🌍!');
  assert.deepEqual(pieces, ['Hi 🌍', '!']);
  assert.ok(!('reasoning_content' in r.data.choices[0].message));
});

test('parallel tool argument fragments assemble by index, independent of arrival order', async () => {
  const raw = event({ tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{"b":' } }, { index: 0, id: 'a', function: { name: 'first', arguments: '{"a":' } }] })
    + event({ tool_calls: [{ index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '2}' } }] }) + end('tool_calls');
  const r = await readAIResponse(response(raw, true));
  assert.deepEqual(openAIAnswer(r.data).tool_calls.map(t => [t.id, t.function.name, JSON.parse(t.function.arguments)]), [['a', 'first', { a: 1 }], ['b', 'second', { b: 2 }]]);
});

test('SSE accepts CR-only line endings and a terminal finish without a DONE sentinel', async () => {
  const raw = (event({ content: 'done' }) + event({}, 'stop')).replace(/\r\n/g, '\r');
  const result = await readAIResponse(response(raw, true));
  assert.equal(openAIAnswer(result.data).content, 'done');
});

test('interrupted, malformed and failed streams cannot return a successful partial answer', async () => {
  for (const raw of [event({ content: 'partial' }), event({ content: 'partial' }) + 'data: [DONE]\n\n', 'data: {broken}\n\n', event({ content: 'partial' }) + 'event: error\ndata: {"error":{"message":"engine died"}}\n\n', event({ content: 'filtered' }) + end('content_filter')]) {
    await assert.rejects(readAIResponse(response(raw)));
  }
});

test('streamed output exhaustion and reasoning-only replies retain token errors', async () => {
  const length = await readAIResponse(response(event({ content: 'partial' }) + end('length')));
  assert.throws(() => openAIAnswer(length.data), e => e.code === 'ai_tokens_output');
  const reasoning = await readAIResponse(response(event({ reasoning_content: 'secret' }) + end('stop')));
  assert.throws(() => openAIAnswer(reasoning.data), e => e.code === 'ai_tokens_reasoning');
});

test('JSON success and HTTP errors remain readable when providers ignore the stream flag', async () => {
  for (const status of [200, 400, 401, 503]) {
    const data = status === 200 ? { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] } : { error: { message: 'provider error' } };
    assert.deepEqual(await readAIResponse(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })), { ok: status === 200, status, data });
  }
});

test('relay text is incremental, final result preserves fallback metadata and error status', async () => {
  const pieces = [];
  const result = { ok: true, status: 200, data: { choices: [{ message: { content: 'hello' } }], trace_tools_unsupported: true } };
  const raw = ': connected\n\nevent: trace-text\ndata: {"text":"hel"}\n\nevent: trace-text\ndata: {"text":"lo"}\n\nevent: trace-result\ndata: ' + JSON.stringify(result) + '\n\n';
  assert.deepEqual(await readAIResponse(response(raw, true), { onText: t => pieces.push(t) }), result);
  assert.deepEqual(pieces, ['hel', 'lo']);
  const failure = { ok: false, status: 502, data: { error: { message: 'truncated', code: 'ai_tokens_output' } } };
  assert.deepEqual(await readAIResponse(response('event: trace-result\ndata: ' + JSON.stringify(failure) + '\n\n')), failure);
  await assert.rejects(readAIResponse(response('event: trace-text\ndata: {"text":"partial"}\n\n')));
});

test('inactivity timeout resets on heartbeats, rather than limiting total generation time', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let n = 0;
    const timer = setInterval(() => {
      res.write(': thinking\n\n');
      if (++n === 6) { clearInterval(timer); res.end(event({ content: 'done' }) + end('stop')); }
    }, 50);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetchAIResponse(fetch, `http://127.0.0.1:${server.address().port}`, {}, { idleMs: 200 });
    assert.equal(openAIAnswer(r.data).content, 'done');
  } finally { server.closeAllConnections(); server.close(); }
});

test('a silent upstream is aborted, and caller cancellation reaches the fetch', async () => {
  const fetcher = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(fetchAIResponse(fetcher, 'unused', {}, { idleMs: 20 }), e => e.name === 'TimeoutError');
  const controller = new AbortController();
  const promise = fetchAIResponse(fetcher, 'unused', {}, { signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(promise, /cancelled/);
});

test('inactivity after headers cancels the response body as well as the request', async () => {
  let closed = false;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(event({ content: 'partial' }));
    res.on('close', () => { closed = true; });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(fetchAIResponse(fetch, `http://127.0.0.1:${server.address().port}`, {}, { idleMs: 100 }), e => e.name === 'TimeoutError');
    for (let n = 0; n < 50 && !closed; n++) await new Promise(r => setTimeout(r, 10));
    assert.equal(closed, true);
  } finally { server.closeAllConnections(); server.close(); }
});

test('custom tool loops execute only fully received and validated calls', async () => {
  globalThis.BroadcastChannel = undefined;
  const { callAI, setToolHandler } = await import('../src/lib/aiChat.js');
  const original = globalThis.fetch;
  const seen = [], actions = [], text = [];
  setToolHandler((name, args) => { actions.push([name, args]); return { ok: true }; });
  let mode = 'tools';
  globalThis.fetch = async (_url, init) => {
    const b = JSON.parse(init.body); seen.push(b);
    assert.equal(b.stream, true);
    if (mode === 'tools' && !b.messages.some(m => m.role === 'tool')) return response(event({ tool_calls: [{ index: 0, id: 'call1', function: { name: 'save_note', arguments: '{"text":' } }] }) + event({ tool_calls: [{ index: 0, function: { arguments: '"done"}' } }] }) + end('tool_calls'), true);
    if (mode === 'cut') return response(event({ tool_calls: [{ index: 0, id: 'call2', function: { name: 'save_note', arguments: '{"text":"partial"}' } }] }));
    if (mode === 'bad-group') return response(event({ tool_calls: [{ index: 0, id: 'a', function: { name: 'save_note', arguments: '{}' } }, { index: 1, id: 'b', function: { name: 'save_note', arguments: '{' } }] }) + end('tool_calls'));
    return response(event({ reasoning_content: 'private' }) + event({ content: 'Saved' }) + end('stop'));
  };
  const args = { provider: 'custom', model: 'local', baseUrl: 'http://local', systemPrompt: 'test', messages: [{ role: 'user', content: 'save' }], tools: [{ name: 'save_note', parameters: { type: 'object' } }], onText: (t, reset) => { if (!reset) text.push(t); } };
  try {
    assert.equal(await callAI(args), 'Saved');
    assert.deepEqual(actions, [['save_note', { text: 'done' }]]);
    assert.deepEqual(text, ['Saved']);
    assert.equal(seen[1].messages.at(-1).role, 'tool');
    for (mode of ['cut', 'bad-group']) await assert.rejects(callAI(args));
    assert.equal(actions.length, 1, 'neither a disconnected stream nor a malformed group executed writes');
  } finally { globalThis.fetch = original; setToolHandler(null); }
});
