import assert from 'node:assert/strict';
import test from 'node:test';
import { noteKey, applyOrder, moveId, mergeOrder } from '../src/lib/note-order.js';

const notes = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
const key = (n) => noteKey(n);

test('keys prefer the server id', () => {
  assert.equal(noteKey({ id: 5 }), 's5');
  assert.equal(noteKey({ id: 5, server_id: 90 }, { native: true }), 's90');
  assert.equal(noteKey({ id: 5, server_id: null }, { native: true }), 'l5');
});

test('applyOrder puts unknown notes first, then the saved order', () => {
  assert.deepEqual(applyOrder(notes, ['s3', 's1'], key).map(n => n.id), [2, 4, 3, 1]);
  assert.deepEqual(applyOrder(notes, [], key).map(n => n.id), [1, 2, 3, 4]);
});

test('moveId moves before or after a target', () => {
  assert.deepEqual(moveId([1, 2, 3, 4], 1, 3, false), [2, 1, 3, 4]);
  assert.deepEqual(moveId([1, 2, 3, 4], 1, 3, true), [2, 3, 1, 4]);
  assert.deepEqual(moveId([1, 2, 3, 4], 4, 1, false), [4, 1, 2, 3]);
  assert.deepEqual(moveId([1, 2, 3], 2, 2, true), [1, 2, 3]);
});

test('mergeOrder keeps keys outside the section', () => {
  assert.deepEqual(mergeOrder(['s1', 's2', 's3', 's9'], ['s3', 's1']), ['s3', 's1', 's2', 's9']);
  assert.deepEqual(mergeOrder(null, ['s2']), ['s2']);
});
