import test from 'node:test';
import assert from 'node:assert/strict';
import { createTraceChatRequests } from '../src/lib/trace-chat.js';

test('each chat reply, including an error, emits one completion with no response content', async () => {
  const completed = [];
  const requests = createTraceChatRequests({ scope: () => 'alice', onComplete: event => completed.push(event) });
  const a = requests.begin('Trace'), b = requests.begin('Trace');
  await a.complete(); await a.complete(); await b.complete('failed');
  assert.equal(completed.length, 2);
  assert.equal(completed[0].kind, 'trace-chat');
  assert.notEqual(completed[0].key, completed[1].key);
  assert.equal(completed[1].failure, 'failed');
  assert.equal(completed[0].body, undefined);
  assert.equal(requests.isCurrent(completed[0].key), true);
});

test('account changes and clear invalidate pending chat replies and notification taps', async () => {
  let account = 'alice', calls = 0, key;
  const requests = createTraceChatRequests({ scope: () => account, onComplete: event => { calls++; key = event.key; } });
  const a = requests.begin(); account = 'bob';
  assert.equal(a.isCurrent(), false); await a.complete();
  const b = requests.begin(); await b.complete();
  const c = requests.begin(); requests.clear();
  assert.equal(c.isCurrent(), false); await c.complete();
  assert.equal(calls, 1);
  assert.equal(requests.isCurrent(key), false);
});

test('reloading chat does not reuse notification history identities', async () => {
  const keys = [];
  for (let i = 0; i < 2; i++) {
    const requests = createTraceChatRequests({ scope: () => 'alice', onComplete: e => keys.push(e.key) });
    await requests.begin().complete();
  }
  assert.notEqual(keys[0], keys[1]);
});

test('notification failures never reject a completed chat request', async () => {
  const requests = createTraceChatRequests({ scope: () => 'alice', onComplete: () => { throw Error('OS unavailable'); } });
  await assert.doesNotReject(requests.begin().complete());
});
