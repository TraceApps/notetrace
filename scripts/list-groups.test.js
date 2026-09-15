import assert from 'node:assert/strict';
import test from 'node:test';
import { groupNotes } from '../src/lib/list-groups.js';

const notes = [
  { id: 1, pinned: true, labels: [10], color: 'moss', updated_at: '2026-09-14 10:00:00' },
  { id: 2, labels: [10, 11], color: null, updated_at: '2026-09-13 10:00:00' },
  { id: 3, labels: [], color: 'moss', updated_at: '2026-09-14 09:00:00' },
];
const labels = [{ id: 10, name: 'Home' }, { id: 11, name: 'Work' }];

test('none: pinned, then the rest', () => {
  const g = groupNotes(notes, 'none');
  assert.deepEqual(g.map(x => [x.kind, x.notes.map(n => n.id)]), [['pinned', [1]], ['others', [2, 3]]]);
});

test('label: a note shows under each of its labels, then No Label', () => {
  const g = groupNotes(notes, 'label', { labels });
  assert.deepEqual(g.map(x => [x.key, x.notes.map(n => n.id)]), [['l10', [1, 2]], ['l11', [2]], ['l-none', [3]]]);
});

test('color: palette order with the default last', () => {
  const g = groupNotes(notes, 'color');
  assert.deepEqual(g.map(x => [x.color, x.notes.map(n => n.id)]), [['moss', [1, 3]], [null, [2]]]);
});

test('date: by edited day, newest first', () => {
  const g = groupNotes(notes, 'date', { now: new Date('2026-09-14T12:00:00') });
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].notes.map(n => n.id), [1, 3]);
});
