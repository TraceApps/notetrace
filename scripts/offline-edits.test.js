import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOps, listView, overlayList, buildPush, createdIds, isOfflineError, isTempId, tasksDueCount, matchesQuery, stamp,
} from '../src/lib/offline-edits.js';

const T0 = Date.parse('2026-09-16T12:00:00Z');
const note = (id, extra = {}) => ({
  id, title: `Note ${id}`, body_md: '', kind: 'text', color: null, pinned: false, archived: false, in_tasks: false,
  trashed_at: null, reminder_at: null, updated_at: '2026-09-15 10:00:00', labels: [], items: [], attachments: [],
  share_role: 'owner', ...extra,
});
const list = (id, items, extra = {}) => note(id, { kind: 'checklist', items, ...extra });
const item = (uuid, position, extra = {}) => ({ uuid, text: uuid, checked: false, position, due_date: null, due_repeat: null, checked_at: null, ...extra });

test('network failures count as offline, server refusals do not', () => {
  assert.equal(isOfflineError(new TypeError('Failed to fetch')), true);
  assert.equal(isOfflineError(Object.assign(new Error('x'), { status: 503 })), true);
  assert.equal(isOfflineError(new Error('API error 502')), true);
  assert.equal(isOfflineError(Object.assign(new Error('Invalid CSRF token'), { status: 403 })), false);
  assert.equal(isOfflineError(new Error('Note not found')), false);
});

test('edits apply in order and stamp the note', () => {
  const byId = applyOps([note(1)], [
    { type: 'update', id: 1, patch: { title: 'First', color: 'sky' }, at: T0 },
    { type: 'update', id: 1, patch: { title: 'Second', labels: [4] }, at: T0 + 1000 },
  ]);
  const n = byId.get(1);
  assert.equal(n.title, 'Second');
  assert.equal(n.color, 'sky');
  assert.deepEqual(n.labels, [4]);
  assert.equal(n.updated_at, stamp(T0 + 1000));
  assert.equal(n.offline, true);
});

test('the original notes are left untouched', () => {
  const original = list(1, [item('a', 1)]);
  applyOps([original], [{ type: 'updateItem', id: 1, uuid: 'a', patch: { checked: true }, at: T0 }]);
  assert.equal(original.items[0].checked, false);
});

test('a note made offline gets its items and a temp id', () => {
  const byId = applyOps([], [{ type: 'create', id: -5, at: T0, note: { kind: 'checklist', title: 'Trip', items: [{ uuid: 'x', text: 'Tickets', position: 1 }] } }]);
  const n = byId.get(-5);
  assert.equal(isTempId(n.id), true);
  assert.equal(n.items[0].text, 'Tickets');
  assert.equal(n.archived, false);
});

test('checklist items add, check, move, and go', () => {
  const byId = applyOps([list(1, [item('a', 1), item('b', 2)])], [
    { type: 'addItem', id: 1, item: { uuid: 'c', text: 'C', position: 1 }, at: T0 },
    { type: 'updateItem', id: 1, uuid: 'a', patch: { checked: true }, at: T0 + 1 },
    { type: 'reorderItems', id: 1, uuids: ['b', 'c', 'a'], at: T0 + 2 },
    { type: 'deleteItem', id: 1, uuid: 'b', at: T0 + 3 },
  ]);
  const items = byId.get(1).items;
  assert.deepEqual(items.map(i => i.uuid), ['c', 'a']);
  assert.equal(items.find(i => i.uuid === 'a').checked, true);
  assert.ok(items.find(i => i.uuid === 'a').checked_at);
});

test('ticking a repeating task moves its date instead of checking it', () => {
  const byId = applyOps([list(1, [item('a', 1, { due_date: '2026-09-16', due_repeat: 'daily' })])], [
    { type: 'updateItem', id: 1, uuid: 'a', patch: { checked: true, today: '2026-09-16' }, at: T0 },
  ]);
  const a = byId.get(1).items[0];
  assert.equal(a.checked, false);
  assert.equal(a.due_date, '2026-09-17');
});

test('views filter and sort like the server', () => {
  const notes = [
    note(1, { updated_at: '2026-09-10' }),
    note(2, { pinned: true, updated_at: '2026-09-01' }),
    note(3, { archived: true }),
    note(4, { trashed_at: '2026-09-12' }),
    note(5, { reminder_at: '2026-09-20T09:00:00Z' }),
    note(6, { share_role: 'edit' }),
    note(7, { labels: [9], title: 'Jellyfin setup', updated_at: '2026-09-16 08:00:00' }),
  ];
  assert.deepEqual(listView(notes).map(n => n.id).slice(0, 2), [2, 7]);
  assert.deepEqual(listView(notes, { view: 'archive' }).map(n => n.id), [3]);
  assert.deepEqual(listView(notes, { view: 'trash' }).map(n => n.id), [4]);
  assert.deepEqual(listView(notes, { view: 'reminders' }).map(n => n.id), [5]);
  assert.deepEqual(listView(notes, { view: 'shared' }).map(n => n.id), [6]);
  assert.deepEqual(listView(notes, { label: 9 }).map(n => n.id), [7]);
  assert.deepEqual(listView(notes, { q: 'jelly' }).map(n => n.id), [7]);
});

test('search matches word beginnings in titles, text, and items', () => {
  assert.equal(matchesQuery(list(1, [item('Oat milk', 1, { text: 'Oat milk' })]), 'mil'), true);
  assert.equal(matchesQuery(note(1, { body_md: 'setup notes' }), 'etup'), false);
  assert.equal(matchesQuery(note(1, { title: 'Home Server' }), 'home serv'), true);
});

test('a server list shows waiting edits: changes, moves out, and new notes', () => {
  const server = [note(1), note(2), note(3)];
  const ops = [
    { type: 'update', id: 1, patch: { title: 'Edited' }, at: T0 },
    { type: 'update', id: 2, patch: { archived: true }, at: T0 },
    { type: 'create', id: -1, note: { title: 'Made offline' }, at: T0 },
  ];
  const shown = overlayList(server, ops, { view: 'notes' });
  assert.deepEqual(shown.map(n => n.title).sort(), ['Edited', 'Made offline', 'Note 3']);
  const archive = overlayList([], ops, { view: 'archive' }, server);
  assert.deepEqual(archive.map(n => n.id), [2]);
  assert.equal(overlayList(server, [], { view: 'notes' }), server);
});

test('Tasks Due counts open dated items on active lists', () => {
  const notes = [
    list(1, [item('a', 1, { due_date: '2026-09-16' }), item('b', 2, { due_date: '2026-09-20' }), item('c', 3, { due_date: '2026-09-01', checked: true })]),
    list(2, [item('d', 1, { due_date: '2026-09-10' })], { archived: true }),
  ];
  assert.equal(tasksDueCount(notes, '2026-09-16'), 1);
});

test('the push sends only what changed, stamped when it changed', () => {
  const base = [list(1, [item('a', 1), item('b', 2)], { labels: [3] }), note(2)];
  const ops = [
    { type: 'update', id: 1, patch: { pinned: true, labels: [4] }, at: T0 },
    { type: 'updateItem', id: 1, uuid: 'a', patch: { text: 'A!' }, at: T0 + 1000 },
    { type: 'deleteItem', id: 1, uuid: 'b', at: T0 + 2000 },
    { type: 'addItem', id: 1, item: { uuid: 'tmp', text: 'Gone' }, at: T0 + 3000 },
    { type: 'deleteItem', id: 1, uuid: 'tmp', at: T0 + 4000 },
    { type: 'trash', id: 2, at: T0 + 5000 },
  ];
  const baseMap = new Map(base.map(n => [n.id, n]));
  const { tables } = buildPush(ops, baseMap, applyOps(base, ops));

  const n1 = tables.notes.find(r => r.server_id === 1);
  assert.deepEqual(Object.keys(n1).sort(), ['client_id', 'pinned', 'server_id', 'updated_at']);
  assert.equal(n1.updated_at, stamp(T0 + 4000));
  const n2 = tables.notes.find(r => r.server_id === 2);
  assert.ok(n2.trashed_at);

  const a = tables.checklist_items.find(r => r.uuid === 'a');
  assert.equal(a.text, 'A!');
  assert.equal(a.note_id, 1);
  assert.equal(a.updated_at, stamp(T0 + 1000));
  assert.equal(a._local_fks, undefined);
  const b = tables.checklist_items.find(r => r.uuid === 'b');
  assert.equal(b.deleted_at, stamp(T0 + 2000));
  assert.equal(tables.checklist_items.some(r => r.uuid === 'tmp'), false, 'added and removed offline: nothing to send');

  assert.equal(n1.pinned, 1, 'booleans go up as 0 and 1');
  const labels = tables.note_labels.map(r => [r.label_id, r.deleted_at ? 'removed' : 'added']);
  assert.deepEqual(labels.sort(), [[3, 'removed'], [4, 'added']]);
});

test('a note made offline goes up whole, its items and labels pointing at it', () => {
  const ops = [
    { type: 'create', id: -7, at: T0, note: { kind: 'checklist', title: 'New', labels: [2], items: [{ uuid: 'i1', text: 'One', position: 1 }] } },
    { type: 'addItem', id: -7, item: { uuid: 'i2', text: 'Two' }, at: T0 + 1 },
  ];
  const { tables } = buildPush(ops, new Map(), applyOps([], ops));
  assert.equal(tables.notes.length, 1);
  assert.equal(tables.notes[0].client_id, -7);
  assert.equal(tables.notes[0].server_id, undefined);
  assert.equal(tables.notes[0].kind, 'checklist');
  assert.deepEqual(tables.checklist_items.map(r => [r.uuid, r.note_id, r._local_fks?.[0]]), [['i1', -7, 'note_id'], ['i2', -7, 'note_id']]);
  assert.deepEqual(tables.note_labels.map(r => [r.label_id, r.note_id, r._local_fks?.[0]]), [[2, -7, 'note_id']]);
});

test('server ids come back for notes made offline', () => {
  assert.deepEqual(createdIds({ tables: { notes: [{ client_id: -7, server_id: 42 }, { client_id: 3, server_id: 3 }] } }), { '-7': 42 });
  assert.deepEqual(createdIds({}), {});
});

// ── What the other Trace apps taught us ─────────────────────────────

test('a picture attached with no connection belongs to the note at once', () => {
  const ops = [{ type: 'create', id: -5, at: 1, note: { title: 'Snap', kind: 'text', attachments: [{ uuid: 'a1', url: 'data:image/jpeg;base64,x', mime: 'image/jpeg' }] } }];
  const note = applyOps([], ops).get(-5);
  assert.equal(note.attachments.length, 1);
  assert.equal(note.attachments[0].url, 'data:image/jpeg;base64,x');
});

test('a note made offline with no picture still carries an empty list', () => {
  const note = applyOps([], [{ type: 'create', id: -6, at: 1, note: { title: 'Plain', kind: 'text' } }]).get(-6);
  assert.deepEqual(note.attachments, []);
});
