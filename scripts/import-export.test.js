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
  attachments: [{ filePath: 'a.jpg', mimetype: 'image/jpeg' }, { filePath: 'memo.3gp', mimetype: 'audio/3gpp' }],
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
  assert.equal(note.color, 'sage');
  assert.equal(note.pinned, true);
  assert.equal(note.created_at, '2024-09-10 20:26:40');
  assert.equal(note.updated_at, '2024-09-12 14:06:40');
  assert.deepEqual(note.files, [{ name: 'a.jpg' }]);
  assert.equal(attachments, 1); // the voice recording
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
  const r = parseKeepNote({ textContent: '', title: '', isTrashed: false, attachments: [{ filePath: 'a.m4a', mimetype: 'audio/mp4' }, {}] });
  assert.equal(r.note, null);
  assert.equal(r.attachments, 2);
  const photoOnly = parseKeepNote({ textContent: '', title: '', isTrashed: false, attachments: [{ filePath: 'p.png', mimetype: 'image/png' }] });
  assert.equal(photoOnly.note.files.length, 1); // a photo-only note is still a note
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

test('markdown: local image embeds become files, remote images stay', () => {
  const n = parseMarkdownNote('vault/Trips/Lisbon.md', '![](../img/tram%2028.jpg)\n\nGreat view ![remote](https://x.test/a.png)\n\n![[sunset.PNG|300]]\n\n![[Other note]]');
  assert.deepEqual(n.files, [{ path: 'vault/img/tram 28.jpg' }, { name: 'sunset.PNG' }]);
  assert.match(n.body_md, /^Great view !\[remote\]\(https:\/\/x\.test\/a\.png\)/);
  assert.match(n.body_md, /!\[\[Other note\]\]/); // note embeds aren't images
});

test('export: images round trip, and a checklist with images stays a checklist', () => {
  const note = { id: 9, title: 'Garden', kind: 'checklist', items: [{ text: 'Tomatoes', checked: false }], created_at: '2026-09-01 12:00:00', updated_at: '2026-09-01 12:00:00' };
  const md = noteToMarkdown(note, [], ['../attachments/abc 1.jpg']);
  assert.match(md, /!\[\]\(\.\.\/attachments\/abc%201\.jpg\)/);
  const back = parseMarkdownNote('NoteTrace/Notes/Garden.md', md);
  assert.equal(back.kind, 'checklist');
  assert.deepEqual(back.items, note.items);
  assert.deepEqual(back.files, [{ path: 'NoteTrace/attachments/abc 1.jpg' }]);
});

import { parseBlinkoBackup, isBlinkoBackup } from '../src/lib/import-export/blinko.js';

const blinko = {
  exportTime: '2026-09-01T00:00:00Z',
  version: '1.6.0',
  notes: [
    { id: 1, account: { name: 'alex' }, content: 'Call the plumber #home\n\n![leak](/api/file/leak.jpg)', isArchived: false, isTop: true, createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-02T10:00:00.000Z', type: 0, attachments: [{ name: 'leak.jpg', path: '/api/file/leak.jpg', type: 'image/jpeg' }, { name: 'quote.pdf', path: '/api/file/quote.pdf', type: 'application/pdf' }] },
    { id: 2, account: { name: 'alex' }, content: '- [ ] Milk\n- [x] Bread', isArchived: true, isTop: false, createdAt: '2026-08-03T10:00:00.000Z', updatedAt: '2026-08-03T10:00:00.000Z', type: 2, attachments: [] },
    { id: 3, account: { name: 'sam' }, content: 'Sam private note', createdAt: '2026-08-03T10:00:00.000Z', updatedAt: '2026-08-03T10:00:00.000Z', attachments: [] },
  ],
};

test('blinko: backup notes, tags from content, images, checklists; one account only', () => {
  assert.equal(isBlinkoBackup(blinko), true);
  const none = parseBlinkoBackup(blinko, { username: 'nobody' });
  assert.equal(none.notes.length, 0, 'several accounts and no match imports nothing');
  assert.deepEqual(none.accounts, ['alex', 'sam']);
  const r = parseBlinkoBackup(blinko, { username: 'ALEX' });
  assert.equal(r.notes.length, 2);
  const [a, b] = r.notes;
  assert.equal(a.body_md, 'Call the plumber #home');
  assert.deepEqual(a.labels, ['home']);
  assert.deepEqual(a.files, [{ name: 'leak.jpg' }], 'embed of a listed attachment is not added twice');
  assert.equal(a.pinned, true);
  assert.equal(a.created_at, '2026-08-01 10:00:00');
  assert.equal(r.attachments, 1, 'the PDF is counted, not imported');
  assert.equal(b.kind, 'checklist');
  assert.equal(b.archived, true);
  assert.deepEqual(b.items, [{ text: 'Milk', checked: false }, { text: 'Bread', checked: true }]);
});

test('blinko: Markdown export file names give the date, not a title', () => {
  const n = parseMarkdownNote('note-12-1754042400000.md', 'Idea #work\n![x](./files/x.png)');
  assert.equal(n.title, '');
  assert.equal(n.created_at, '2025-08-01 10:00:00');
  assert.deepEqual(n.files, [{ path: 'files/x.png' }]);
});

import { parseMemo, memosBaseUrl } from '../src/lib/import-export/memos.js';

test('memos: current API memo with tags, pin, archive, images, and a link', () => {
  const r = parseMemo({
    name: 'memos/abc', state: 'ARCHIVED', creator: 'users/1', pinned: true,
    createTime: '2026-07-01T09:30:00Z', updateTime: '2026-07-02T09:30:00Z',
    content: '# Reading list\n\nFinish the Le Guin #books', tags: ['books', 'someday'],
    attachments: [
      { name: 'attachments/u1', filename: 'cover photo.jpg', type: 'image/jpeg' },
      { name: 'attachments/u2', filename: 'notes.pdf', type: 'application/pdf' },
      { name: 'attachments/u3', filename: 'Site', type: '', externalLink: 'https://example.com' },
    ],
  }, { userName: 'users/1' });
  const n = r.note;
  assert.equal(n.title, 'Reading list');
  assert.equal(n.body_md, 'Finish the Le Guin #books\n\n[Site](https://example.com)');
  assert.deepEqual(n.labels, ['books', 'someday']);
  assert.equal(n.pinned, true);
  assert.equal(n.archived, true);
  assert.equal(n.created_at, '2026-07-01 09:30:00');
  assert.deepEqual(n.files, [{ path: '/file/attachments/u1/cover%20photo.jpg', name: 'cover photo.jpg' }]);
  assert.equal(r.otherFiles, 1);
});

test('memos: other people\'s memos, comments, and old-API resources', () => {
  assert.equal(parseMemo({ name: 'memos/1', content: 'x', creator: 'users/2' }, { userName: 'users/1' }), null);
  assert.equal(parseMemo({ name: 'memos/2', content: 'reply', creator: 'users/1', parent: 'memos/1' }, { userName: 'users/1' }), null);
  const old = parseMemo({ name: 'memos/3', rowStatus: 'ACTIVE', creator: 'users/1', content: '- [ ] milk\n- [x] eggs', displayTime: '2024-01-01T00:00:00Z',
    resources: [{ name: 'resources/9', filename: 'a.png', type: 'image/png' }] }, { userName: 'users/1' });
  assert.equal(old.note.kind, 'checklist');
  assert.equal(old.note.archived, false);
  assert.deepEqual(old.note.files, [{ path: '/file/resources/9/a.png', name: 'a.png' }]);
  assert.equal(parseMemo({ name: 'memos/4', creator: 'users/1', content: 'no heading here' }, { userName: 'users/1' }).note.title, '', 'untitled memos stay untitled');
  assert.equal(memosBaseUrl('memos.home.lan/'), 'https://memos.home.lan');
  assert.equal(memosBaseUrl('http://10.0.0.5:5230//'), 'http://10.0.0.5:5230');
});

import { createHash } from 'node:crypto';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import { md5Hex, base64ToBytes } from '../src/lib/import-export/md5.js';
import { parseEnex, enexDate, notebookFromFileName } from '../src/lib/import-export/evernote.js';

const parseXml = (s, mime) => new XmlDomParser({ onError: () => {} }).parseFromString(s, mime);
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwnwEIGGEMAB3gA/1cYUXVAAAAAElFTkSuQmCC';

test('md5 matches node crypto', () => {
  for (const s of ['', 'a', 'The quick brown fox jumps over the lazy dog', 'x'.repeat(1000)]) {
    assert.equal(md5Hex(new TextEncoder().encode(s)), createHash('md5').update(s).digest('hex'));
  }
  const png = base64ToBytes(PNG_B64);
  assert.equal(md5Hex(png), createHash('md5').update(Buffer.from(PNG_B64, 'base64')).digest('hex'));
});

const pngHash = createHash('md5').update(Buffer.from(PNG_B64, 'base64')).digest('hex');
const enex = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20260901T120000Z" application="Evernote" version="10.100">
  <note>
    <title>Kitchen reno &amp; budget</title>
    <created>20250115T103000Z</created>
    <updated>20250220T081500Z</updated>
    <tag>Home</tag><tag>Projects</tag>
    <note-attributes>
      <source-url>https://example.com/cabinets</source-url>
      <reminder-time>20990101T090000Z</reminder-time>
    </note-attributes>
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note><div>Quote from <b>Acme</b>:&nbsp;<a href="https://acme.test/q">see quote</a></div><div>Total 5 * 3 = 15_000</div><div><br/></div><en-media hash="${pngHash}" type="image/png"/><ul><li>Cabinets</li><li>Counters<ul><li>Quartz</li></ul></li></ul><div><en-todo checked="true"/>Measure</div><div><en-todo checked="false"/>Order tiles</div><table><tr><td>Item</td><td>Cost</td></tr><tr><td>Sink</td><td>$300</td></tr></table></en-note>]]></content>
    <resource>
      <data encoding="base64">${PNG_B64.replace(/(.{20})/g, '$1\n')}</data>
      <mime>image/png</mime><width>2</width><height>2</height>
      <resource-attributes><file-name>sketch.png</file-name></resource-attributes>
    </resource>
    <resource>
      <data encoding="base64">JVBERi0xLjQK</data>
      <mime>application/pdf</mime>
      <resource-attributes><file-name>quote.pdf</file-name></resource-attributes>
    </resource>
  </note>
  <note>
    <title>Packing</title>
    <created>20250301T000000Z</created>
    <content><![CDATA[<en-note><ul style="--en-todo:true;"><li style="--en-checked:true;"><div>Passport</div></li><li style="--en-checked:false;"><div>Charger</div></li></ul></en-note>]]></content>
    <task><title>Book taxi</title><taskStatus>open</taskStatus></task>
  </note>
  <note>
    <title>Old reminder</title>
    <content><![CDATA[<en-note><div>text</div></en-note>]]></content>
    <note-attributes><reminder-time>20200101T090000Z</reminder-time></note-attributes>
  </note>
</en-export>`;

test('evernote: text, formatting, lists, todos, tables, images by hash, tags, notebook, reminder', () => {
  const r = parseEnex(enex, { parseXml, notebook: notebookFromFileName('exports/Home Projects.enex') });
  assert.equal(r.notes.length, 3);
  assert.equal(r.attachments, 1, 'the PDF is counted');
  const [a, b, c] = r.notes;
  assert.equal(a.title, 'Kitchen reno & budget');
  assert.equal(a.kind, 'text');
  assert.equal(a.created_at, '2025-01-15 10:30:00');
  assert.equal(a.updated_at, '2025-02-20 08:15:00');
  assert.deepEqual(a.labels, ['Home', 'Projects', 'Home Projects']);
  assert.equal(a.reminder_at, '2099-01-01 09:00:00');
  assert.deepEqual(a.files.map(f => f.name), ['sketch.png']);
  assert.equal(a.body_md, [
    'Quote from **Acme**: [see quote](https://acme.test/q)  \nTotal 5 \\* 3 = 15\\_000',
    '- Cabinets\n- Counters\n  - Quartz\n- [x] Measure\n- [ ] Order tiles',
    'Item | Cost  \nSink | $300',
    'https://example.com/cabinets',
  ].join('\n\n'));
  assert.equal(b.kind, 'checklist');
  assert.deepEqual(b.items, [{ text: 'Passport', checked: true }, { text: 'Charger', checked: false }, { text: 'Book taxi', checked: false }]);
  assert.equal(c.reminder_at, null, 'past reminders are dropped');
  assert.equal(enexDate('20250115T103000Z'), '2025-01-15 10:30:00');
  assert.equal(notebookFromFileName('Evernote.enex'), '');
});

import { groupByDay } from '../src/lib/timeline.js';

test('timeline groups notes by local day, newest first', () => {
  const now = new Date(2026, 8, 14, 15, 0);           // Sep 14 2026, local
  const at = (y, m, d, h) => new Date(y, m, d, h).toISOString();
  const notes = [
    { id: 1, updated_at: at(2026, 8, 14, 9) },
    { id: 2, updated_at: at(2026, 8, 13, 22) },
    { id: 3, updated_at: at(2026, 8, 14, 11) },
    { id: 4, updated_at: at(2026, 8, 10, 8) },
    { id: 5, updated_at: at(2026, 1, 2, 8) },
    { id: 6, updated_at: at(2024, 11, 25, 8) },
  ];
  const g = groupByDay(notes, { now });
  assert.deepEqual(g.map(x => x.kind), ['today', 'yesterday', 'week', 'year', 'older']);
  assert.deepEqual(g[0].notes.map(n => n.id), [3, 1]);
  assert.equal(groupByDay([{ id: 7, updated_at: '2026-09-14 12:00:00' }], { now })[0].notes.length, 1);
});
