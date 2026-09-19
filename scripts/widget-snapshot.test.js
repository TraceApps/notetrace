import { test } from 'node:test';
import assert from 'node:assert/strict';
import { widgetSnapshot, widgetText, WIDGET_NOTES } from '../src/lib/widget-snapshot.js';

const t = (k) => `<${k}>`;

test('pinned notes come first, then the newest edits', () => {
  const snap = widgetSnapshot([
    { id: 1, title: 'Old', updated_at: '2026-09-01 10:00:00' },
    { id: 2, title: 'New', updated_at: '2026-09-15 10:00:00' },
    { id: 3, title: 'Pinned', pinned: true, updated_at: '2026-08-01 10:00:00' },
    { id: 4, title: 'Archived', archived: true, updated_at: '2026-09-16 10:00:00' },
    { id: 5, title: 'Trashed', trashed_at: '2026-09-16', updated_at: '2026-09-16 10:00:00' },
  ], { t });
  assert.deepEqual(snap.notes.map(n => n.id), [3, 2, 1]);
  assert.equal(snap.notes[0].pinned, true);
  assert.equal(snap.locked, false);
});

test('App Lock sends nothing but the lock', () => {
  assert.deepEqual(widgetSnapshot([{ id: 1, title: 'Secret' }], { locked: true }), { locked: true, notes: [] });
});

test('the widget keeps a screenful or two', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: i, title: `N${i}`, updated_at: `2026-09-${String(i % 28 + 1).padStart(2, '0')}` }));
  assert.equal(widgetSnapshot(many, { t }).notes.length, WIDGET_NOTES);
});

test('colours become the dot colour, and the default has none', () => {
  const [a, b] = widgetSnapshot([{ id: 1, color: 'sky', updated_at: '2' }, { id: 2, color: null, updated_at: '1' }], { t }).notes;
  assert.equal(a.color, '#7ED4FF');
  assert.equal(b.color, null);
});

test('a list shows its open items in order', () => {
  const text = widgetText({ kind: 'checklist', items: [
    { text: 'Milk', position: 2 }, { text: 'Eggs', position: 1 }, { text: 'Done', position: 3, checked: true },
  ] }, t);
  assert.equal(text, '☐ Eggs\n☐ Milk');
  assert.equal(widgetText({ kind: 'checklist', items: [{ text: 'x', checked: true }] }, t), '<widget.all_done>');
});

test('text is plain, and an empty note says what it holds', () => {
  assert.equal(widgetText({ kind: 'text', body_md: '## Hi\n\n**bold** [[Link]]' }, t), 'Hi\nbold Link');
  assert.equal(widgetText({ kind: 'text', body_md: '', attachments: [{ mime: 'image/png', url: '/uploads/a.png', is_drawing: true }] }, t), '<widget.drawing>');
  assert.equal(widgetText({ kind: 'text', body_md: '', attachments: [{ mime: 'audio/webm', url: '/uploads/a.webm' }] }, t), '<widget.voice_note>');
  assert.equal(widgetText({ kind: 'text', body_md: '' }, t), '');
});
