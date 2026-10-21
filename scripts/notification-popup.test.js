import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { createNotificationPopup } from '../src/lib/notification-popup.js';
import { createNotificationHistory } from '../src/lib/notification-history.js';

test('new alerts replace the popup, restart expiry, and dismiss without losing history', () => {
  const pending = new Map(); let serial = 0;
  const popup = createNotificationPopup({ schedule: (fn, ms) => { assert.equal(ms, 6000); pending.set(++serial, fn); return serial; }, cancel: id => pending.delete(id) });
  const data = new Map();
  const history = createNotificationHistory({ scope: () => 'a', storage: { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v) }, onAdd: e => popup.show(e), onClear: () => popup.dismiss() });
  history.add({ id: 'a', title: 'First', body: 'Review' });
  history.add({ id: 'b', title: 'Second', body: 'Review' });
  assert.equal(get(popup).id, 'b'); assert.equal(pending.size, 1);
  [...pending.values()][0]();
  assert.equal(get(popup), null); assert.equal(get(history).length, 2);
  history.add({ id: 'c', title: 'Third', body: 'Review' });
  history.clear(); assert.equal(get(popup), null);
});

test('loading saved history never pops up old alerts', () => {
  let popups = 0;
  const history = createNotificationHistory({ scope: () => 'a', storage: { getItem: () => JSON.stringify([{ id: 'old', title: 'Old', body: 'Review', time: 1 }]) }, onAdd: () => popups++ });
  history.load(); history.load(true); assert.equal(popups, 0);
});
