import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesFilters, emptyFilters, toggleFilter, hasFilters } from '../src/lib/note-filters.js';

const notes = [
  { id: 1, kind: 'checklist', items: [{ text: 'Milk' }], color: 'moss', labels: [3] },
  { id: 2, kind: 'text', body_md: 'See https://example.com/guide', attachments: [{ url: '/uploads/a.jpg', mime: 'image/jpeg' }] },
  { id: 3, kind: 'text', body_md: 'Call', reminder_at: '2099-01-01 09:00:00', attachments: [{ url: '/uploads/v.webm', mime: 'audio/webm' }], share_count: 2 },
  { id: 4, kind: 'checklist', items: [{ text: 'Read http://news.example.org' }], share_role: 'edit', color: 'rose' },
];
const ids = (f) => notes.filter(n => matchesFilters(n, f)).map(n => n.id);

test('no filters match everything', () => {
  assert.equal(hasFilters(emptyFilters()), false);
  assert.deepEqual(ids(emptyFilters()), [1, 2, 3, 4]);
});

test('types match any choice within the group', () => {
  let f = toggleFilter(emptyFilters(), 'types', 'checklist');
  assert.deepEqual(ids(f), [1, 4]);
  f = toggleFilter(f, 'types', 'images');
  assert.deepEqual(ids(f), [1, 2, 4]);
  assert.deepEqual(ids(toggleFilter(emptyFilters(), 'types', 'voice')), [3]);
  assert.deepEqual(ids(toggleFilter(emptyFilters(), 'types', 'links')), [2, 4]);
  assert.deepEqual(ids(toggleFilter(emptyFilters(), 'types', 'shared')), [3, 4]);
  assert.deepEqual(ids(toggleFilter(emptyFilters(), 'types', 'reminders')), [3]);
});

test('groups combine, and toggling twice removes a filter', () => {
  const f = toggleFilter(toggleFilter(emptyFilters(), 'types', 'checklist'), 'colors', 'rose');
  assert.deepEqual(ids(f), [4]);
  assert.deepEqual(ids(toggleFilter(emptyFilters(), 'labels', 3)), [1]);
  assert.equal(hasFilters(toggleFilter(toggleFilter(emptyFilters(), 'colors', 'moss'), 'colors', 'moss')), false);
});

test('Files matches notes with a document, and Images only matches pictures', () => {
  const pdf = { kind: 'text', attachments: [{ mime: 'application/pdf', url: '/uploads/a.pdf' }] };
  const pic = { kind: 'text', attachments: [{ mime: 'image/jpeg', url: '/uploads/a.jpg' }] };
  const f = (types) => ({ types, colors: [], labels: [] });
  assert.equal(matchesFilters(pdf, f(['files'])), true);
  assert.equal(matchesFilters(pdf, f(['images'])), false);
  assert.equal(matchesFilters(pic, f(['images'])), true);
  assert.equal(matchesFilters(pic, f(['files'])), false);
});
