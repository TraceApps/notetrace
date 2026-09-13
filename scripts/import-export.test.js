/**
 * Google Keep and Markdown import parsing, Markdown export, and the
 * export-to-import round trip (src/lib/import-export).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseKeepNote, isKeepNote } from '../src/lib/import-export/keep.js';
import {
  parseMarkdownNote, parseFrontMatter, noteToMarkdown, exportFileName, plainTextToMarkdown, inlineTags,
} from '../src/lib/import-export/markdown.js';

const keepText = {
  color: 'TEAL',
  isTrashed: false,
  isPinned: true,
  isArchived: false,
  textContent: 'Buy a new filter\nfor the furnace\n\nModel 16x25',
  title: 'Home stuff',
  userEditedTimestampUsec: 1726150000000000,
  createdTimestampUsec: 1726000000000000,
  labels: [{ name: 'Home' }, { name: 'Errands' }],
  annotations: [{ description: '', source: 'WEBLINK', title: 'Filters', url: 'https://example.com/filters' }],
  attachments: [{ filePath: 'a.jpg', mimetype: 'image/jpeg' }],
};

const keepList = {
  color: 'DEFAULT',
  isTrashed: false,
  isPinned: false,
  isArchived: true,
  title: 'Groceries',
  userEditedTimestampUsec: 1726150000000000,
  createdTimestampUsec: 1726100000000000,
  listContent: [
    { textHtml: 'Limes', text: 'Limes', isChecked: false },
    { textHtml: 'Rice', text: 'Rice', isChecked: true },
    { text: '   ', isChecked: false },
  ],
};

test('keep: text note keeps line breaks, links, labels, color, pin, and dates', () => {
  const { note, attachments } = parseKeepNote(keepText);
  assert.equal(note.kind, 'text');
  assert.equal(note.title, 'Home stuff');
  assert.equal(note.body_md, 'Buy a new filter  \nfor the furnace\n\nModel 16x25\n\n[Filters](https://example.com/filters)');
  assert.deepEqual(note.labels, ['Home', 'Errands']);
  assert.equal(note.color, 'tide');
  assert.equal(note.pinned, true);
  assert.equal(note.created_at, '2024-09-10 20:26:40');
  assert.equal(note.updated_at, '2024-09-12 14:06:40');
  assert.equal(attachments, 1);
});

test('keep: checklist keeps order and checked state, drops blank items', () => {
  const { note } = parseKeepNote(keepList);
  assert.equal(note.kind, 'checklist');
  assert.deepEqual(note.items, [{ text: 'Limes', checked: false }, { text: 'Rice', checked: true }]);
  assert.equal(note.archived, true);
  assert.equal(note.color, null);
});

test('keep: non-note JSON is ignored and attachment-only notes are counted', () => {
  assert.equal(isKeepNote({ name: 'Labels' }), false);
  assert.equal(parseKeepNote([1, 2]), null);
  const r = parseKeepNote({ textContent: '', title: '', isTrashed: false, attachments: [{}, {}] });
  assert.equal(r.note, null);
  assert.equal(r.attachments, 2);
});

test('markdown: front matter subset (quoted, inline and block lists, booleans)', () => {
  const { data, body } = parseFrontMatter('---\ntitle: "A: B"\ntags:\n  - one\n  - "two words"\nlabels: [x, \'y\']\npinned: true\n---\nHello');
  assert.equal(data.title, 'A: B');
  assert.deepEqual(data.tags, ['one', 'two words']);
  assert.deepEqual(data.labels, ['x', 'y']);
  assert.equal(data.pinned, true);
  assert.equal(body, 'Hello');
});

test('markdown: title from front matter, then H1, then a meaningful file name', () => {
  assert.equal(parseMarkdownNote('a.md', '---\ntitle: FM\n---\n# H1\nbody').title, 'FM');
  const h1 = parseMarkdownNote('a.md', '# Weekly plan\n\nbody text');
  assert.equal(h1.title, 'Weekly plan');
  assert.equal(h1.body_md, 'body text');
  assert.equal(parseMarkdownNote('vault/Project ideas.md', 'body').title, 'Project ideas');
  assert.equal(parseMarkdownNote('memos/2024-05-01T10-30-00.md', 'a memo').title, '');
  assert.equal(parseMarkdownNote('Untitled 3.md', 'x').title, '');
});

test('markdown: inline #tags become labels, headings and code do not', () => {
  assert.deepEqual(inlineTags('Idea for #work and #side-project/\n# Heading\n`#notatag` #42'), ['work', 'side-project']);
  const n = parseMarkdownNote('m.md', 'Ship it #work', { tagsToLabels: true });
  assert.deepEqual(n.labels, ['work']);
  assert.deepEqual(parseMarkdownNote('m.md', 'Ship it #work', { tagsToLabels: false }).labels, []);
});

test('markdown: a file of only tasks becomes a checklist', () => {
  const n = parseMarkdownNote('todo.md', '- [ ] Milk\n- [x] Eggs\n');
  assert.equal(n.kind, 'checklist');
  assert.deepEqual(n.items, [{ text: 'Milk', checked: false }, { text: 'Eggs', checked: true }]);
  assert.equal(parseMarkdownNote('mixed.md', 'Intro\n- [ ] Milk').kind, 'text');
});

test('markdown: plain text files keep their line breaks; Archive folder archives', () => {
  const n = parseMarkdownNote('Archive/old.txt', 'line one\nline two');
  assert.equal(n.body_md, 'line one  \nline two');
  assert.equal(n.archived, true);
  assert.equal(plainTextToMarkdown('a\r\n\r\n\r\nb  '), 'a\n\nb');
});

test('export: round trip keeps content, labels, color, pin, archive, reminder, and dates', () => {
  const original = {
    id: 7, title: 'Trip: "Lisbon"', kind: 'checklist', body_md: '', color: 'plum', pinned: true, archived: false,
    items: [{ text: 'Passport', checked: true }, { text: 'Adapter', checked: false }],
    reminder_at: '2026-10-01 08:00:00', reminder_rrule: 'weekly', reminder_tz: 'Europe/Lisbon',
    created_at: '2026-09-01 12:00:00', updated_at: '2026-09-02 13:30:00',
  };
  const md = noteToMarkdown(original, ['Travel', 'Family']);
  const back = parseMarkdownNote('NoteTrace/Notes/Trip.md', md);
  assert.equal(back.title, original.title);
  assert.equal(back.kind, 'checklist');
  assert.deepEqual(back.items, original.items);
  assert.deepEqual(back.labels, ['Travel', 'Family']);
  assert.equal(back.color, 'plum');
  assert.equal(back.pinned, true);
  assert.equal(back.reminder_at, original.reminder_at);
  assert.equal(back.reminder_rrule, 'weekly');
  assert.equal(back.reminder_tz, 'Europe/Lisbon');
  assert.equal(back.created_at, original.created_at);
  assert.equal(back.updated_at, original.updated_at);

  const text = { id: 8, title: '', kind: 'text', body_md: 'Hello **there**\n\n#not-a-label-here', created_at: '2026-09-01 12:00:00', updated_at: '2026-09-01 12:00:00' };
  const tb = parseMarkdownNote('NoteTrace/Notes/Note 8.md', noteToMarkdown(text, []), { tagsToLabels: false });
  assert.equal(tb.body_md, text.body_md);
  assert.equal(tb.title, ''); // untitled stays untitled, not named after its file
});

test('export: file names are safe and unique per folder', () => {
  const used = new Set();
  assert.equal(exportFileName({ title: 'a/b: c?' }, used), 'a b c.md');
  assert.equal(exportFileName({ title: 'A B C' }, used), 'A B C (2).md');
  assert.equal(exportFileName({ id: 3, title: '' }, used), 'Note 3.md');
  assert.equal(exportFileName({ title: 'Follow-up' }, used), 'Follow-up.md');
});
