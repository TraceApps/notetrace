import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeTokenLimits, estimatePromptTokens, applyTokenLimits, serverTokenLimits, openAIAnswer } from '../src/lib/ai-token-limits.js';

const body = { model: 'local', messages: [{ role: 'system', content: 'You are Trace.' }, { role: 'user', content: 'Make a table.' }] };
const error = code => e => e.code === `ai_tokens_${code}`;

test('custom defaults reserve 16K output without assuming a context size', () => {
  assert.deepEqual(normalizeTokenLimits(), { maxTokens: 16384, contextSize: 0 });
  assert.deepEqual(normalizeTokenLimits({ maxTokens: '32768', contextSize: '262144' }), { maxTokens: 32768, contextSize: 262144 });
  const request = applyTokenLimits(body);
  assert.equal(request.max_tokens, 16384);
  assert.ok(!('min_tokens' in request) && !('contextSize' in request));
});

test('invalid counts cannot produce NaN, fractions or an impossible response budget', () => {
  for (const value of [null, [], { maxTokens: -1 }, { maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: Infinity }, { maxTokens: 'abc' }, { maxTokens: true }, { maxTokens: {} }, { maxTokens: 1048577 }, { maxTokens: 4096, contextSize: 4096 }]) {
    assert.throws(() => normalizeTokenLimits(value), error('invalid'), JSON.stringify(value));
  }
});

test('context budget includes system messages, history, tool results and schemas', () => {
  const request = { ...body, messages: [...body.messages, { role: 'tool', content: 'a'.repeat(400) }], tools: [{ function: { name: 'search', description: 'b'.repeat(300) } }] };
  assert.ok(estimatePromptTokens(request) > estimatePromptTokens(body));
  const contextSize = estimatePromptTokens(request) + 100;
  const result = applyTokenLimits(request, { maxTokens: 200, contextSize });
  assert.equal(result.max_tokens, 100);
  assert.deepEqual(result.messages, request.messages, 'never silently remove note text or history');
  assert.throws(() => applyTokenLimits({ ...request, messages: [{ role: 'user', content: 'x'.repeat(5000) }] }, { maxTokens: 200, contextSize }), error('context'));
});

test('image URLs/base64 are not mistaken for text tokens', () => {
  const image = { ...body, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }] };
  assert.equal(estimatePromptTokens(image), null);
  assert.equal(applyTokenLimits(image, { maxTokens: 1024, contextSize: 2048 }).max_tokens, 1024);
});

test('administrator ceilings are enforced, including context disabled by the client', () => {
  assert.throws(() => serverTokenLimits({ maxTokens: 32768 }, { ai_max_tokens: '16384' }), error('server'));
  assert.deepEqual(serverTokenLimits({ maxTokens: 8192 }, { ai_context_size: '32768' }), { maxTokens: 8192, contextSize: 32768 });
  assert.throws(() => serverTokenLimits({ maxTokens: 8192 }, { ai_context_size: 'broken' }), error('server'));
  assert.throws(() => serverTokenLimits({ maxTokens: 8192 }, { ai_context_size: '4096' }), error('server'));
});

test('truncated rewrites and tool calls are rejected before they can be applied or executed', () => {
  for (const message of [{ content: 'Partial table' }, { content: null, reasoning_content: 'Still thinking' }, { tool_calls: [{ function: { arguments: '{' } }] }]) {
    assert.throws(() => openAIAnswer({ choices: [{ finish_reason: 'length', message }] }), error('output'));
  }
  assert.throws(() => openAIAnswer({ choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: 'Thinking only' } }] }), error('reasoning'));
  assert.equal(openAIAnswer({ choices: [{ finish_reason: 'stop', message: { content: 'Complete table', reasoning_content: 'Private reasoning' } }] }).content, 'Complete table');
});

test('client/server helpers are identical and settings sync with the account', () => {
  const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.equal(read('../src/lib/ai-token-limits.js'), read('../server/lib/ai-token-limits.js'));
  assert.match(read('../src/stores/settings.js').split('export const DEVICE_PREFS')[0], /'aiTokenLimits'/);
  for (const path of ['../src/lib/trace-run.js', '../src/components/ai/Trace.svelte', '../src/components/settings/SettingsTrace.svelte']) assert.match(read(path), /tokenLimits:.*aiTokenLimits/);
});
