import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { createNotificationHistory } from '../src/lib/notification-history.js';

function fixture() {
  const data = new Map();
  let account = 'alice@server-a';
  let time = 100;
  const storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
  const make = () => createNotificationHistory({ storage, scope: () => account, now: () => ++time, limit: 3 });
  return { data, make, account: value => { account = value; } };
}
const event = id => ({ id, kind: 'trace-result', noteId: 7, title: 'Ready', body: 'Review Trip' });

test('history survives reload, stays newest first and limits retained entries', () => {
  const f = fixture(), h = f.make();
  for (const id of ['a', 'b', 'c', 'd']) h.add(event(id));
  const reloaded = f.make(); reloaded.load();
  assert.deepEqual(get(reloaded).map(e => e.id), ['d', 'c', 'b']);
  assert.ok(get(reloaded).every(e => e.read === false));
});
test('a repeated Trace completion replaces its old entry and becomes unread again', () => {
  const f = fixture(), h = f.make();
  h.add(event('trace')); h.markRead('trace');
  const oldTime = get(h)[0].time;
  h.add(event('other')); h.add(event('trace'));
  assert.deepEqual(get(h).map(e => e.id), ['trace', 'other']);
  assert.equal(get(h)[0].read, false);
  assert.ok(get(h)[0].time > oldTime);
  h.markRead(); assert.ok(get(h).every(e => e.read));
});
test('accounts and servers do not share entries, and reset erases the loaded account only', () => {
  const f = fixture(), h = f.make();
  h.add(event('alice-a'));
  f.account('alice@server-b'); h.load(); assert.deepEqual(get(h), []);
  h.add(event('alice-b'));
  f.account('bob@server-b'); h.load(); assert.deepEqual(get(h), []);
  h.add(event('bob')); h.reset(); assert.deepEqual(get(h), []);
  h.load(); assert.deepEqual(get(h), []);
  f.account('alice@server-a'); h.load(); assert.equal(get(h)[0].id, 'alice-a');
});
test('cross-tab reload observes read/clear changes without deleting stored entries', () => {
  const f = fixture(), first = f.make(), second = f.make();
  first.add(event('one')); second.load();
  second.markRead(); first.load(true); assert.equal(get(first)[0].read, true);
  second.clear(); first.load(true); assert.deepEqual(get(first), []);
});
test('malformed storage and unavailable localStorage do not break delivery', () => {
  const f = fixture(); f.data.set('alice@server-a', '[null,{}]');
  const h = f.make(); h.load(); assert.deepEqual(get(h), []);
  f.data.set('alice@server-a', '{invalid'); h.load(true); assert.deepEqual(get(h), []);
  const broken = createNotificationHistory({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } }, scope: () => 'a' });
  broken.add(event('one')); assert.equal(get(broken).length, 1);
  broken.reset(); assert.deepEqual(get(broken), []);
});
