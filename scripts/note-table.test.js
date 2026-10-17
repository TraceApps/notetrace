/**
 * Tables in text notes (TraceApps/notetrace#26).
 *
 * A table is saved as a Markdown table, and the editor keeps every table in
 * the shape Markdown holds (one line per cell, the first row the header, no
 * merged cells, one alignment per column), so a note reloads exactly as it
 * was saved. Before tables, a note that already held one (from an import,
 * the API or Trace) showed without it, and the next save erased it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import Highlight from '@tiptap/extension-highlight';
import { MarkdownManager } from '@tiptap/markdown';
import { Marked } from 'marked';
import { EditorState, TextSelection, Selection } from '@tiptap/pm/state';
import { history, undo, redo } from '@tiptap/pm/history';
import * as tables from '@tiptap/pm/tables';
import { NoteTables, escapeCellPipes, normalizeTables, tableShapePlugin } from '../src/lib/note-table.js';
import { NoteLink } from '../src/lib/note-link-extension.js';
import { directionDecorations } from '../src/lib/tiptap-direction.js';
import { markdownToPreview } from '../src/lib/note-preview.js';
import { plainExcerpt } from '../server/lib/note-excerpt.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
// The editor's extensions, as TipTapEditor.svelte and note-print.js load them.
const extensions = [StarterKit.configure({ heading: { levels: [1, 2, 3] } }), TaskList, TaskItem.configure({ nested: true }), Highlight, NoteLink, ...NoteTables];
const schema = getSchema(extensions);
// Each with its own marked: the default one is shared, and registering tables would change the other.
const md = new MarkdownManager({ marked: new Marked(), extensions });
const withoutTables = new MarkdownManager({ marked: new Marked(), extensions: extensions.slice(0, 5) });
// Through the schema, so both sides carry the same default attributes.
const reload = (d) => schema.nodeFromJSON(md.parse(md.serialize(d))).toJSON();

const P = (content) => ({ type: 'paragraph', content: content.length ? content : undefined });
const cell = (type, content, align = null) => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, align }, content: [P(content)] });
const table = (rows, aligns = []) => ({
  type: 'table',
  content: rows.map((r, i) => ({ type: 'tableRow', content: r.map((c, j) => cell(i ? 'tableCell' : 'tableHeader', c, aligns[j] ?? null)) })),
});
const text = (t, marks) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const doc = (...content) => schema.nodeFromJSON({ type: 'doc', content }).toJSON();

test('a note that holds a table keeps it: it shows, and saving writes it back', () => {
  const src = 'Packing list\n\n| Item | Qty |\n| --- | --- |\n| Socks | 3 |\n\nDone';
  const parsed = md.parse(src);
  assert.deepEqual(parsed.content.map((n) => n.type), ['paragraph', 'table', 'paragraph']);
  assert.equal(md.serialize(parsed), 'Packing list\n\n| Item  | Qty |\n| ----- | --- |\n| Socks | 3   |\n\nDone');
  // And without the table extension, what the editor did before: the table was gone.
  assert.equal(withoutTables.serialize(withoutTables.parse(src)), 'Packing list\n\nDone');
});

test('a note without a real table loads and saves exactly as before', () => {
  // Lines with pipes that aren't a table (the dashes don't match the columns): the
  // package's start() once split such a paragraph into single letters.
  for (const src of [
    'Total: 5 | 6\n:-- | --: | --',
    'Price | Qty | Total\n--- | ---\nmore text',
    '| a |\n|---|---|',
    '| [[Note|alias]] | b |\n| - | - |',
    'one | two\nthree',
    'x | y\n---',
    '```\n| a | b |\n| --- | --- |\n```',
  ]) assert.equal(md.serialize(md.parse(src)), withoutTables.serialize(withoutTables.parse(src)), JSON.stringify(src));
});

test('a line break in a cell is kept, saved as <br> the way GitHub and Obsidian write it', () => {
  const src = '| x<br>y | z |\n| --- | --- |\n| a<br/>b | c |';
  const parsed = md.parse(src);
  assert.deepEqual(parsed.content[0].content[0].content[0].content[0].content.map((n) => n.type), ['text', 'hardBreak', 'text']);
  assert.equal(md.serialize(parsed), '| x<br>y | z   |\n| ------ | --- |\n| a<br>b | c   |');
  // Typed as text, <br> stays text.
  const typed = doc(table([[[text('a <br> b')]]]));
  assert.deepEqual(reload(typed), typed);
});

test('a | typed in a cell stays in its cell', () => {
  assert.equal(escapeCellPipes('a | b'), 'a \\| b');
  assert.equal(escapeCellPipes('already \\| escaped'), 'already \\| escaped');
  assert.equal(escapeCellPipes('`a|b` and c|d'), '`a|b` and c\\|d');
  assert.equal(escapeCellPipes('``x`|`y`` z|'), '``x`|`y`` z\\|');
  assert.equal(escapeCellPipes('open ` tick | here'), 'open ` tick \\| here');
  const d = doc(table([[[text('H|1')], [text('H2')]], [[text('a | b')], [text('c|d', [{ type: 'code' }])]], [[text('\\|x')], []]]));
  assert.deepEqual(reload(d), d);
});

test('saving and reloading gives back the same table, whatever is typed in it', () => {
  // A small random source: same tables every run, many shapes and characters.
  let seed = 26;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pieces = ['Milk', 'oat milk', '2', '½ cup', 'a | b', '|', '\\', '\\|', '*', '_x_', '**', '`', '[x]', '#', '- item', '1.', '> q', '<b>', '&amp;', 'حليب', 'שלום', '😀', ' ', 'x  y', '==', ']]', '[[', ':--', '---'];
  const marks = [null, [{ type: 'bold' }], [{ type: 'italic' }], [{ type: 'code' }], [{ type: 'strike' }], [{ type: 'highlight' }], [{ type: 'link', attrs: { href: 'https://example.com/a?b=1|2' } }]];
  let checked = 0;
  for (let round = 0; round < 400; round++) {
    const cols = 1 + rnd(4), rows = 1 + rnd(4);
    const aligns = Array.from({ length: cols }, () => [null, 'left', 'center', 'right'][rnd(4)]);
    const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => {
      const parts = [];
      for (let k = rnd(3); k > 0; k--) {
        const t = pieces[rnd(pieces.length)].trim();
        const m = marks[rnd(marks.length)];
        // Left out: code with a backslash (right before a |, the one thing a Markdown table
        // can't hold: marked reads \| in a table row as an escaped pipe, even in code), and
        // code holding a backtick, which the Markdown writer gets wrong anywhere in a note.
        if (t && !(m?.[0].type === 'code' && /[\\`]/.test(t))) parts.push(text(t, m));
      }
      if (rnd(5) === 0) parts.push({ type: 'noteLink', attrs: { title: 'Trip plan' } });
      return parts;
    }));
    const before = rnd(2) ? [P([text('Before')])] : [];
    // At the top of the note, or in a quote or a list item.
    const t = table(grid, aligns);
    const where = [
      t,
      { type: 'blockquote', content: [P([text('q')]), t] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [P([text('item')]), t] }] },
      { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [P([text('one')])] }, { type: 'listItem', content: [P([text('two')]), t] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [P([text('task')]), t] }] },
    ][rnd(5)];
    let d;
    try { d = doc(...before, where, P([text('After')])); } catch { continue; }
    const once = md.serialize(d);
    const back = schema.nodeFromJSON(md.parse(once)).toJSON();
    const find = (n) => (n.type === 'table' ? n : (n.content || []).map(find).find(Boolean));
    const tbl = find(back);
    assert.ok(tbl, `round ${round}: no table after reload: ${once}`);
    // The same rows and columns, the header row first.
    assert.deepEqual(tbl.content.map((r) => r.content.map((c) => c.type)), grid.map((r, i) => r.map(() => (i ? 'tableCell' : 'tableHeader'))), `round ${round}: ${once}`);
    // Each cell gives back what was typed in it, or at worst what the same text gives back
    // as a paragraph of its own: a table loses nothing a paragraph doesn't. (Markdown reads a
    // few things back differently anywhere, like bold right before strikethrough between
    // punctuation.) Runs of spaces count as one: a cell is written on one line.
    const squash = (j) => JSON.stringify(j ?? []).replace(/ {2,}/g, ' ');
    grid.forEach((r, i) => r.forEach((c, j) => {
      const typed = schema.nodeFromJSON(doc(P(c))).toJSON().content[0].content;
      const alone = schema.nodeFromJSON(md.parse(md.serialize(doc(P(c))))).toJSON().content?.[0]?.content;
      const got = squash(tbl.content[i].content[j].content[0].content);
      assert.ok(got === squash(typed) || got === squash(alone), `round ${round}, cell ${i},${j}: ${once}\n got ${got}\n typed ${squash(typed)}`);
    }));
    // And a second save writes the same Markdown.
    assert.equal(md.serialize(md.parse(md.serialize(back))), md.serialize(back), `round ${round}`);
    checked++;
  }
  assert.ok(checked > 350, `only ${checked} tables`);
});

test('tables inside a quote or a list are kept too', () => {
  const t = table([[[text('A')], [text('B')]], [[text('1')], [text('2')]]]);
  for (const d of [
    doc({ type: 'blockquote', content: [P([text('q')]), t] }),
    doc({ type: 'bulletList', content: [{ type: 'listItem', content: [P([text('item')]), t] }] }),
    // A numbered item needs the blank line before its table, or the table reads as its text.
    doc({ type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [P([text('one')])] }, { type: 'listItem', content: [P([text('two')]), t] }] }),
    doc({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [P([text('task')]), t] }] }),
    doc({ type: 'blockquote', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [P([text('deep')]), t] }] }] }),
  ]) {
    assert.deepEqual(reload(d), d, md.serialize(d));
    assert.equal(md.serialize(reload(d)), md.serialize(d));
  }
  // At the top of a note, no blank lines of its own.
  assert.equal(md.serialize(doc(t)), '| A   | B   |\n| --- | --- |\n| 1   | 2   |');
});

test('a table out of shape is put in the shape Markdown holds', () => {
  const T = schema.nodes;
  const c = (type, content, attrs = {}) => type.create({ colspan: 1, rowspan: 1, colwidth: null, align: null, ...attrs }, T.paragraph.create(null, content));
  const bad = T.doc.create(null, [T.table.create(null, [
    T.tableRow.create(null, [c(T.tableCell, schema.text('Head')), c(T.tableCell, schema.text('B'), { colwidth: [120], align: 'right' })]),
    T.tableRow.create(null, [c(T.tableHeader, schema.text('a b')), c(T.tableCell, schema.text('x'), { align: 'center' })]),
  ])]);
  let state = EditorState.create({ schema, doc: bad });
  const tr = normalizeTables(state);
  assert.ok(tr);
  state = state.apply(tr);
  const rows = state.doc.firstChild.content.content.map((r) => r.content.content.map((x) => `${x.type.name}:${x.textContent}:${x.attrs.align}:${x.attrs.colwidth}`));
  assert.deepEqual(rows, [
    ['tableHeader:Head:null:null', 'tableHeader:B:right:null'],
    ['tableCell:a b:null:null', 'tableCell:x:right:null'],
  ]);
  // Already in shape: nothing to do, and it reloads as it is.
  assert.equal(normalizeTables(state), null);
  assert.deepEqual(reload(state.doc.toJSON()), state.doc.toJSON());
});

test('an Arabic table reads right to left, an English one left to right', () => {
  const d = schema.nodeFromJSON(doc(table([[[text('الصنف')], [text('Qty')]]]), table([[[text('Item')], [text('الكمية')]]])));
  const dirs = [];
  d.forEach((node, offset) => {
    const deco = directionDecorations(d).find(offset, offset + node.nodeSize).find((x) => x.from === offset);
    dirs.push(deco?.type.attrs.dir);
  });
  assert.deepEqual(dirs, ['rtl', 'ltr']);
});

test('cards, link previews and reminders read a table row by row', () => {
  const src = 'Plan\n\n| Day | Meal |\n| :-- | ---: |\n| Mon | Soup \\| bread |\n|  | **Tea** |\n\nEnd';
  assert.equal(markdownToPreview(src), 'Plan\nDay · Meal\nMon · Soup | bread\nTea\nEnd');
  assert.equal(plainExcerpt(src), 'Plan\nDay · Meal\nMon · Soup | bread\nTea\nEnd');
  // A table in a quote, a line break in a cell.
  assert.equal(markdownToPreview('> | a | b |\n> | --- | --- |\n> | x<br>y | 2 |'), 'a · b\nx y · 2');
  // A rule line with no pipe is still a rule, not a table line.
  assert.equal(markdownToPreview('a\n\n---\n\nb'), 'a\nb');
  // The reminder push reads tables with the same two lines.
  const lines = (s) => s.match(/ {4}\/\/ A table reads[^\n]*\n[^\n]*\n[^\n]*\n/)[0];
  assert.equal(lines(read('../server/lib/reminder-delivery.js')), lines(read('../src/lib/note-preview.js')));
  assert.equal(lines(read('../server/lib/note-excerpt.js')), lines(read('../src/lib/note-preview.js')));
});

test('the editor, printing and the public page use the same tables', () => {
  const editor = read('../src/components/notes/TipTapEditor.svelte');
  assert.match(editor, /\.\.\.NoteTables,/);
  assert.match(editor, /key: 'table', icon: 'table', label: 'notes\.fmt_table', notInTable: true/);
  for (const k of ['tableAddRow', 'tableAddColumn', 'tableDeleteRow', 'tableDeleteColumn', 'tableDelete']) assert.match(editor, new RegExp(`key: '${k}'[^\\n]*inTable: true`));
  assert.match(editor, /\{ key: 'table',\s+icon: 'table',\s+words: 'table grid rows columns' \}/);
  // A wide table scrolls by itself, never the page.
  assert.match(editor, /\.tableWrapper\) \{ overflow-x: auto;/);
  assert.match(read('../src/lib/note-print.js'), /Highlight, Markdown, NoteLink, \.\.\.NoteTables\]/);
  // The phone's formatting bar shows the table tools only in a table.
  assert.match(read('../src/components/notes/NoteEditor.svelte'), /fmtTools\.filter\(t => \(t\.inTable \? formats\.table : t\.notInTable \? !formats\.table : true\)\)/);
  // The public page shows a note through the same editor, read-only.
  assert.match(read('../src/routes/PublicNote.svelte'), /<TipTapEditor value=\{note\.body_md\} editable=\{false\}/);
  // Pasted tables are flattened first; no lookbehind (older Safari can't parse it).
  const mod = read('../src/lib/note-table.js');
  assert.match(mod, /props: \{ transformPastedHTML: flattenPastedTables \}/);
  assert.match(mod, /\.\.\.\(this\.parent\?\.\(\) \|\| \[\]\),\s+tableShapePlugin\(\),/);
  assert.doesNotMatch(mod + read('../src/lib/note-preview.js'), /\(\?<[!=]/);
});

test('whatever is done to a table, what shows is what is saved (random edits, undo and redo)', () => {
  let seed = 2026;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const words = ['Milk', 'a | b', '|', '\\', '\\|', '*x*', ' ', 'oat  milk', 'حليب', '`c|d`', '12', '[[Trip]]', '<br>'];
  const cmds = [
    tables.addRowAfter, tables.addRowBefore, tables.addColumnAfter, tables.addColumnBefore,
    tables.deleteRow, tables.deleteColumn,
    // Not on the toolbar, but a paste or a shortcut can do the like: the shape is put back.
    tables.mergeCells, tables.toggleHeaderRow, tables.toggleHeaderColumn, tables.toggleHeaderCell,
    (s, d) => { d(s.tr.insertText(words[rnd(words.length)])); return true; },
    (s, d) => { d(s.tr.insertText(words[rnd(words.length)])); return true; },
    (s, d) => { if (s.selection.empty) return false; d(s.tr.deleteSelection()); return true; },
    (s, d) => { const hb = s.schema.nodes.hardBreak; d(s.tr.replaceSelectionWith(hb.create())); return true; },
    undo, undo, redo,
  ];
  const cellTexts = (d) => { const out = []; d.descendants((n) => { if (n.type.name === 'table') { out.push(n.content.content.map((r) => r.content.content.map((c) => `${c.type.name}:${c.attrs.align}:${c.textContent.replace(/\s+/g, ' ').trim()}`))); return false; } return true; }); return out; };
  let steps = 0;
  for (let round = 0; round < 300; round++) {
    const base = schema.nodeFromJSON(doc(P([text('Top')]), table([[[text('A')], [text('B')]], [[text('1')], [text('2')]]], [null, 'right']), P([text('End')])));
    let state = EditorState.create({ schema, doc: base, plugins: [history(), tables.tableEditing(), tableShapePlugin()] });
    for (let s = 0; s < 150; s++) {
      const size = state.doc.content.size;
      // Mostly somewhere in a table, sometimes anywhere.
      let lo = 1, hi = size - 1, any = false;
      state.doc.forEach((n, off) => { if (n.type.name === 'table') { any = true; if (rnd(5)) { lo = off + 1; hi = off + n.nodeSize - 1; } } });
      if (!any) break; // the table was deleted: a fresh one next round
      const a = lo + rnd(Math.max(1, hi - lo)), b = Math.min(size - 1, a + rnd(8));
      let sel;
      try {
        sel = rnd(4) === 0
          ? tables.CellSelection.create(state.doc, a, b)
          : TextSelection.between(Selection.near(state.doc.resolve(a)).$from, Selection.near(state.doc.resolve(b), -1).$from);
      } catch { continue; }
      state = state.apply(state.tr.setSelection(sel));
      let tr = null;
      try { cmds[rnd(cmds.length)](state, (t) => { tr = t; }); } catch { continue; }
      if (!tr || !tr.docChanged) continue;
      state = state.apply(tr);
      steps++;
      // What saving and reloading gives back: the same tables, cell for cell, and the same Markdown.
      const json = state.doc.toJSON();
      const back = schema.nodeFromJSON(reload(json));
      assert.deepEqual(cellTexts(back), cellTexts(state.doc), `round ${round}, step ${s}: ${md.serialize(json)}`);
      assert.equal(md.serialize(back.toJSON()), md.serialize(json), `round ${round}, step ${s}`);
    }
  }
  assert.ok(steps > 2000, `only ${steps} edits ran`);
});
