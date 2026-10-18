/**
 * Right-to-left text: Arabic, Hebrew and mixed lines (TraceApps/notetrace#21).
 *
 * Each block takes its direction from its first letter, as dir="auto" does:
 * paragraphs and headings through dir="auto" itself, lists, list items,
 * checkboxes and quotes through textDir() (dir="auto" would skip their
 * children's text and leave them left to right). Display only: the note's
 * Markdown is never changed. Rows whose text is in an input take textDir().
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import * as textDirModule from '../src/lib/text-dir.js';
const { textDir } = textDirModule;
import { directionDecorations, noteDirectionPlugin, NoteDirection } from '../src/lib/tiptap-direction.js';
import { EditorState } from '@tiptap/pm/state';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('textDir: the first letter decides, as dir="auto" does', () => {
  const cases = [
    ['مرحبا', 'rtl'], ['שלום', 'rtl'], ['ܫܠܡܐ', 'rtl'],
    ['Hello', 'ltr'], ['Привет', 'ltr'], ['你好', 'ltr'],
    ['123 مرحبا', 'rtl'], ['- عنصر', 'rtl'], ['  English عربي', 'ltr'],
    ['قهوة مع sugar', 'rtl'], ['Coffee مع سكر', 'ltr'],
    ['', undefined], ['42', undefined], ['!? 3.5', undefined], [null, undefined], [undefined, undefined],
  ];
  for (const [text, want] of cases) assert.equal(textDir(text), want, JSON.stringify(text));
});

const schema = getSchema([StarterKit, TaskList, TaskItem.configure({ nested: true })]);
const p = (text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
const doc = schema.nodeFromJSON({
  type: 'doc',
  content: [
    p('مرحبا English.'),
    p('Hello عربي.'),
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'عنوان' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [p('عنصر')] }, { type: 'listItem', content: [p('Item')] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [p('مهمة')] }] },
    { type: 'blockquote', content: [p('اقتباس')] },
    { type: 'codeBlock', content: [{ type: 'text', text: 'كود()' }] },
    p(''),
  ],
});

test('paragraphs and headings carry dir="auto", lists and quotes their own direction', () => {
  // The attribute, rendered on every paragraph and heading.
  const ext = NoteDirection.config.addGlobalAttributes.call({})[0];
  assert.deepEqual(ext.types, ['paragraph', 'heading']);
  assert.deepEqual(ext.attributes.dir.renderHTML(), { dir: 'auto' });
  assert.equal(ext.attributes.dir.default, 'auto');
});

test('the editor gives every block its direction', () => {
  const before = JSON.stringify(doc.toJSON());
  const set = directionDecorations(doc);
  const at = [];
  doc.descendants((node, pos) => {
    const deco = set.find(pos, pos + node.nodeSize).find(d => d.from === pos && d.to === pos + node.nodeSize);
    const a = deco?.type.attrs;
    at.push(`${node.type.name}:${a ? (a.dir || 'follows ' + a['data-empty-dir']) : '-'}`);
  });
  assert.deepEqual(at, [
    // Paragraphs and headings carry dir="auto" themselves (an attribute), no decoration.
    'paragraph:-', 'text:-',
    'paragraph:-', 'text:-',
    'heading:-', 'text:-',
    // A list reads like its first letter; an item only says so when it differs.
    'bulletList:rtl', 'listItem:-', 'paragraph:-', 'text:-', 'listItem:ltr', 'paragraph:-', 'text:-',
    'taskList:rtl', 'taskItem:-', 'paragraph:-', 'text:-',
    'blockquote:rtl', 'paragraph:-', 'text:-',
    'codeBlock:-', 'text:-',
    // An empty line reads like the nearest line above with letters.
    'paragraph:follows rtl',
  ]);
  // Decorations only: the document, and so its Markdown, is unchanged.
  assert.equal(JSON.stringify(doc.toJSON()), before);
});

test('the editor uses it, with styles that follow the direction', () => {
  const ed = read('../src/components/notes/TipTapEditor.svelte');
  assert.match(ed, /import \{ NoteDirection \} from '\.\.\/\.\.\/lib\/tiptap-direction\.js';/);
  const extensions = ed.slice(ed.indexOf('extensions: ['), ed.indexOf('],', ed.indexOf('extensions: [')));
  assert.match(extensions, /\bNoteDirection\b/);
  // Not Tiptap's own textDirection: it puts dir="auto" on lists too, which then find no letters.
  assert.doesNotMatch(ed, /textDirection:/);
  // A line with no letters yet reads like its surroundings, not left to right.
  assert.match(ed, /:has\(> br\.ProseMirror-trailingBreak:only-child\)\) \{ direction: inherit; \}/);
  assert.match(ed, /> \[data-empty-dir="rtl"\]:has\(> br\.ProseMirror-trailingBreak:only-child\)\) \{ direction: rtl; \}/);
  const style = ed.slice(ed.indexOf('<style>'));
  // Note content (.tiptap-body) has no left/right-only spacing.
  const content = style.split('\n').filter(l => l.includes('.tiptap-body'));
  for (const line of content) assert.doesNotMatch(line, /(padding|margin|border)-(left|right)\s*:/, line);
  assert.match(style, /\.tiptap-body code\) \{[^}]*direction: ltr;[^}]*unicode-bidi: isolate;/);
  assert.match(style, /\.tiptap-body pre\) \{[^}]*direction: ltr;/);
});

// An element with this class carries this dir, wherever the attributes sit.
const hasDir = (src, cls, dir) => new RegExp(`<[a-z0-9]+[^>]*class="${cls}"[^>]*\\bdir=${dir}|<[a-z0-9]+[^>]*\\bdir=${dir}[^>]*class="${cls}"`).test(src);

test('titles, previews, items and inputs follow their own text', () => {
  const card = read('../src/components/notes/NoteCard.svelte');
  assert.ok(hasDir(card, 'card-title', '"auto"'));
  assert.ok(hasDir(card, 'card-body', '"auto"'));
  assert.match(card, /<li dir=\{textDir\(item\.text\)\}>/);
  assert.match(card, /text-align: start;/);
  assert.doesNotMatch(card, /text-align: left;/);
  const row = read('../src/components/notes/NoteRow.svelte');
  assert.ok(hasDir(row, 'row-title', '"auto"'));
  assert.ok(hasDir(row, 'row-preview', '"auto"'));
  assert.match(read('../src/components/notes/NoteEditor.svelte'), /class="title-input"\s+dir="auto"/);
  const list = read('../src/components/notes/ChecklistEditor.svelte');
  // Each row its own way; an empty one like the row above (lineDirs).
  assert.match(list, /\$: openDirs = lineDirs\(open\.map\(i => i\.text\)\);/);
  assert.match(list, /<li class="item" dir=\{openDirs\[i\]\}>/);
  assert.match(list, /<li class="item done" dir=\{doneDirs\[i\]\}>/);
  assert.match(list, /class="item-text"\s+dir=\{openDirs\[i\] \|\| 'auto'\}/);
  const listStyle = list.slice(list.indexOf('<style>'));
  assert.doesNotMatch(listStyle.match(/\.handle \{[^}]*\}/)[0], /margin-left/);
  const pub = read('../src/routes/PublicNote.svelte');
  assert.ok(hasDir(pub, 'pn-title', '"auto"'));
  assert.equal((pub.match(/<li dir=\{textDir\(item\.text\)\}>/g) || []).length, 2);
  const tasks = read('../src/routes/Tasks.svelte');
  // While a task is being edited, its row follows what's being typed.
  assert.match(tasks, /<li class="task" dir=\{textDir\(editUuid === task\.uuid \? draft : task\.text\)\}/);
  assert.ok(hasDir(tasks, 'task-text', '"auto"'));
  // The swipe background follows the finger, not the line.
  assert.match(tasks, /\.swipe-bg \{[^}]*direction: ltr;/);
  assert.match(read('../src/routes/Shopping.svelte'), /<li class="item" dir=\{textDir\(it\.name\)\}/);
  assert.match(read('../src/components/ai/Trace.svelte'), /<div class="bubble" dir="auto">/);
  assert.match(read('../src/routes/Notes.svelte'), /<input type="search" dir="auto"/);
});

test('typing keeps the directions exactly as a full rebuild would (random edits)', () => {
  // Only the changed blocks are redone on each keystroke; any slip would show
  // here as a difference from working everything out again.
  const plugin = noteDirectionPlugin();
  const key = plugin.spec.key;
  const P = (t) => schema.nodes.paragraph.create(null, t ? schema.text(t) : null);
  const WORDS = ['مرحبا', 'English', '123', ' ', 'عربي', 'word', '\u200F', '.', 'שלום'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const word = () => WORDS[rnd(WORDS.length)];
  const str = (set) => set.find().map(d => `${d.from}-${d.to}-${JSON.stringify(d.type.attrs)}`).sort().join(',');
  let steps = 0;
  for (let round = 0; round < 80; round++) {
    const blocks = [];
    for (let i = 0; i < 1 + rnd(6); i++) {
      const k = rnd(5);
      if (k === 0) blocks.push(schema.nodes.bulletList.create(null, [schema.nodes.listItem.create(null, P(word())), schema.nodes.listItem.create(null, P(word()))]));
      else if (k === 1) blocks.push(schema.nodes.taskList.create(null, [schema.nodes.taskItem.create({ checked: false }, P(word()))]));
      else if (k === 2) blocks.push(schema.nodes.blockquote.create(null, P(word())));
      else blocks.push(P(rnd(3) ? word() : ''));
    }
    let state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, blocks), plugins: [plugin] });
    for (let s = 0; s < 40; s++) {
      const size = state.doc.content.size;
      const a = 1 + rnd(Math.max(1, size - 1));
      const b = Math.min(size - 1, a + rnd(8));
      const $a = state.doc.resolve(a);
      const tr = state.tr;
      try {
        const op = rnd(5);
        if (op <= 1 && $a.parent.isTextblock) tr.insertText(word(), a);
        else if (op === 2 && $a.parent.isTextblock) tr.split(a);
        else if (op === 3 && b > a) tr.delete(a, b);
        else if (op === 4) tr.insert($a.depth ? $a.before(1) : a, P(rnd(2) ? word() : ''));
        else continue;
      } catch { continue; }
      if (!tr.docChanged) continue;
      state = state.apply(tr);
      steps++;
      assert.equal(str(key.getState(state)), str(directionDecorations(state.doc)), `round ${round}, step ${s}: ${JSON.stringify(state.doc.toJSON()).slice(0, 300)}`);
    }
  }
  assert.ok(steps > 1500, `only ${steps} edits ran`);
});

test('lineDirs: an empty line reads like the one above it', () => {
  const { lineDirs } = textDirModule;
  assert.deepEqual(lineDirs(['حليب', '', 'Bread', '', '']), ['rtl', 'rtl', 'ltr', 'ltr', 'ltr']);
  assert.deepEqual(lineDirs(['', '123', 'قهوة']), [undefined, undefined, 'rtl']);
  // Direction marks count, as for dir="auto".
  assert.equal(textDir('\u200FHello'), 'rtl');
  assert.equal(textDir('\u200Eمرحبا'), 'ltr');
});

test('print and Save as PDF read the same way', () => {
  const pr = read('../src/lib/note-print.js');
  assert.match(pr, /directHtml\(tpl\.content\)/);
  assert.match(pr, /<h1 class=\\?"title\\?" dir=\\?"auto\\?">/);
  const css = pr.slice(pr.indexOf('PRINT_CSS'), pr.indexOf('`;', pr.indexOf('PRINT_CSS')));
  assert.doesNotMatch(css, /(padding|margin|border)-(left|right)\s*:/);
});

test('indent, outdent, wrap, lift, block types and undo keep the directions exact', async () => {
  const { history, undo, redo } = await import('@tiptap/pm/history');
  const { sinkListItem, liftListItem, wrapInList } = await import('@tiptap/pm/schema-list');
  const { wrapIn, lift, setBlockType, joinBackward, splitBlock, deleteSelection } = await import('@tiptap/pm/commands');
  const { TextSelection } = await import('@tiptap/pm/state');
  const plugin = noteDirectionPlugin();
  const key = plugin.spec.key;
  const n = schema.nodes;
  const P = (t) => n.paragraph.create(null, t ? schema.text(t) : null);
  const WORDS = ['مرحبا', 'English', '', '123', 'عربي', 'word', 'שלום'];
  let seed = 11;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  const word = () => WORDS[rnd(WORDS.length)];
  const str = (set) => set.find().map(d => `${d.from}-${d.to}-${JSON.stringify(d.type.attrs)}`).sort().join(',');
  const commands = [
    () => sinkListItem(n.listItem), () => liftListItem(n.listItem),
    () => sinkListItem(n.taskItem), () => liftListItem(n.taskItem),
    () => wrapInList(n.bulletList), () => wrapInList(n.orderedList), () => wrapIn(n.blockquote), () => lift,
    () => setBlockType(n.heading, { level: 1 }), () => setBlockType(n.paragraph),
    () => joinBackward, () => splitBlock, () => deleteSelection,
    () => (state, dispatch) => { // switch a list's type in place
      const $p = state.selection.$from;
      for (let d = $p.depth; d > 0; d--) {
        const node = $p.node(d);
        if (node.type === n.bulletList || node.type === n.orderedList) {
          if (dispatch) dispatch(state.tr.setNodeMarkup($p.before(d), node.type === n.bulletList ? n.orderedList : n.bulletList));
          return true;
        }
      }
      return false;
    },
    () => (state, dispatch) => { if (dispatch) dispatch(state.tr.insertText(word() || 'x')); return true; },
    () => undo, () => undo, () => redo,
  ];
  let steps = 0;
  for (let round = 0; round < 60; round++) {
    const blocks = [];
    for (let i = 0; i < 2 + rnd(5); i++) {
      const k = rnd(4);
      if (k === 0) blocks.push(n.bulletList.create(null, [n.listItem.create(null, P(word())), n.listItem.create(null, [P(word()), n.bulletList.create(null, n.listItem.create(null, P(word())))])]));
      else if (k === 1) blocks.push(n.taskList.create(null, [n.taskItem.create({ checked: false }, P(word())), n.taskItem.create({ checked: true }, P(word()))]));
      else if (k === 2) blocks.push(n.blockquote.create(null, [P(word()), P(word())]));
      else blocks.push(P(word()));
    }
    let state = EditorState.create({ schema, doc: n.doc.create(null, blocks), plugins: [history(), plugin] });
    for (let s = 0; s < 50; s++) {
      const size = state.doc.content.size;
      const a = 1 + rnd(Math.max(1, size - 1));
      const b = Math.min(size - 1, a + rnd(6));
      let sel;
      try { sel = TextSelection.create(state.doc, a, b); } catch { continue; }
      state = state.apply(state.tr.setSelection(sel));
      const cmd = commands[rnd(commands.length)]();
      let tr = null;
      try { cmd(state, (t) => { tr = t; }); } catch { continue; }
      if (!tr || !tr.docChanged) continue;
      state = state.apply(tr);
      steps++;
      assert.equal(str(key.getState(state)), str(directionDecorations(state.doc)), `round ${round}, step ${s}: ${JSON.stringify(state.doc.toJSON()).slice(0, 300)}`);
    }
  }
  assert.ok(steps > 1000, `only ${steps} edits ran`);
});
