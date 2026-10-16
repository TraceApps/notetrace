/**
 * tiptap-direction.js: right-to-left text in the note editor
 * (TraceApps/notetrace#21).
 *
 * Paragraphs and headings always carry dir="auto": the browser reads each
 * one's direction from its first letter, live as it's typed, and lays mixed
 * Arabic and English out in the right order. It's an attribute that never
 * changes, so it costs nothing per keystroke, and it isn't part of the
 * Markdown a note is saved as.
 *
 * Lists and quotes can't use dir="auto": it skips text inside children that
 * have a dir of their own, so they'd find no letters and stay left to right,
 * bullets and boxes on the left of Arabic lines. They get the direction of
 * their own first letter instead (textDir), as decorations; a list item gets
 * one only when it reads differently from its list. A note full of plain
 * lines, or one long list, so has a handful of decorations to carry along.
 *
 * A line with no letters yet reads like its list or quote (CSS in
 * TipTapEditor.svelte); on its own it reads like the nearest line above it
 * that has letters (data-empty-dir, also CSS), so Enter, Enter after an
 * Arabic line leaves the cursor on the right. A separate attribute, so it
 * never fights the paragraph's own dir="auto", and gone once a letter is in.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ReplaceStep } from '@tiptap/pm/transform';
import { textDir } from './text-dir.js';

const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);
const ITEMS = new Set(['listItem', 'taskItem']);
const TEXT = new Set(['paragraph', 'heading']);
const SPEC = { noteDir: true };
// How far back a line with no letters looks for one that has some.
const LOOK_BACK = 50;

// Nodes never change (an edit makes new ones), so each one's answer is kept.
const known = new WeakMap();

/** The direction of a node's first letter, found without building its whole text. */
function firstLetterDir(node) {
  if (known.has(node)) return known.get(node);
  let dir;
  if (node.isText) dir = textDir(node.text);
  else for (let i = 0; i < node.childCount && !dir; i++) dir = firstLetterDir(node.child(i));
  known.set(node, dir);
  return dir;
}

/** The direction a top-level line with no letters follows: the nearest one before it that has some. */
function prevDir(parent, index) {
  for (let i = index - 1; i >= 0 && i >= index - LOOK_BACK; i--) {
    const dir = firstLetterDir(parent.child(i));
    if (dir) return dir;
  }
  return undefined;
}

/** The attributes a node shows, or undefined for none. */
function attrsFor(node, parent, index) {
  const name = node.type.name;
  if (LISTS.has(name) || name === 'blockquote') {
    const dir = firstLetterDir(node);
    return dir && { dir };
  }
  if (ITEMS.has(name)) {
    const dir = firstLetterDir(node);
    return dir && dir !== firstLetterDir(parent) ? { dir } : undefined;
  }
  if (TEXT.has(name) && parent?.type.name === 'doc' && !firstLetterDir(node)) {
    const dir = prevDir(parent, index);
    return dir && { 'data-empty-dir': dir };
  }
  return undefined;
}

const decoFor = (node, pos, parent, index) => {
  const attrs = attrsFor(node, parent, index);
  return attrs ? Decoration.node(pos, pos + node.nodeSize, attrs, SPEC) : null;
};

/** Every list's, quote's and empty line's direction, worked out from scratch. */
export function directionDecorations(doc) {
  const decos = [];
  doc.descendants((node, pos, parent, index) => {
    const d = decoFor(node, pos, parent, index);
    if (d) decos.push(d);
  });
  return DecorationSet.create(doc, decos);
}

const dirOf = (d) => d?.type.attrs.dir;

/**
 * The set after a change. Typing (plain replace steps) redoes only where the
 * change could matter: the changed nodes, the lists and quotes around them,
 * a list's items when its own direction changed, and the empty lines that
 * follow. Anything that rewraps the document (indent, outdent, wrap, lift and
 * their undo) is worked out again from scratch: decorations are few, so that
 * stays quick, and moving them through a rewrap is where they go wrong.
 */
export function updateDirections(set, tr) {
  if (!tr.docChanged) return set;
  const doc = tr.doc;
  if (!tr.steps.every((step) => step instanceof ReplaceStep)) return directionDecorations(doc);
  const kept = set.map(tr.mapping, doc).find();
  let from = Infinity, to = -Infinity;
  tr.mapping.maps.forEach((map, i) => map.forEach((_a, _b, start, end) => {
    const rest = tr.mapping.slice(i + 1);
    from = Math.min(from, rest.map(start, -1));
    to = Math.max(to, rest.map(end, 1));
  }));
  if (from > to) return DecorationSet.create(doc, kept);
  const size = doc.content.size;
  from = Math.max(0, Math.min(from, size));
  to = Math.max(from, Math.min(to, size));

  const redo = new Map(); // pos -> [node, parent, index]
  const add = (pos, node, parent, index) => { if (!redo.has(pos)) redo.set(pos, [node, parent, index]); };
  for (const p of [from, to]) {
    const $p = doc.resolve(p);
    for (let d = 1; d <= $p.depth; d++) add($p.before(d), $p.node(d), $p.node(d - 1), $p.index(d - 1));
  }
  doc.nodesBetween(from, to, (node, pos, parent, index) => { add(pos, node, parent, index); });
  // Top-level lines with no letters after the change read like it.
  let pos = 0;
  const first = doc.resolve(to).index(0);
  for (let i = 0; i < first; i++) pos += doc.child(i).nodeSize;
  for (let i = first; i < doc.childCount; i++) {
    const node = doc.child(i);
    if (i > first && firstLetterDir(node)) break;
    add(pos, node, doc, i);
    pos += node.nodeSize;
  }

  // The decorations of the nodes redone go; the rest stay as they were.
  const old = new Map();
  for (const d of kept) old.set(`${d.from}:${d.to}`, d);
  const fresh = [];
  const redoOne = (p, node, parent, index) => {
    const k = `${p}:${p + node.nodeSize}`;
    const was = old.get(k);
    old.delete(k);
    const d = decoFor(node, p, parent, index);
    if (d) fresh.push(d);
    return [dirOf(was), dirOf(d)];
  };
  for (const [p, [node, parent, index]] of redo) {
    const [was, now] = redoOne(p, node, parent, index);
    // A list that changed direction changes which of its items read differently.
    if (LISTS.has(node.type.name) && was !== now) {
      node.forEach((child, offset, i) => { if (!redo.has(p + 1 + offset)) redoOne(p + 1 + offset, child, node, i); });
    }
  }
  return DecorationSet.create(doc, [...old.values(), ...fresh]);
}

const key = new PluginKey('noteDirection');

/** The plugin on its own (the extension below wraps it for Tiptap). */
export function noteDirectionPlugin() {
  return new Plugin({
    key,
    state: {
      init: (_, { doc }) => directionDecorations(doc),
      apply: (tr, old) => updateDirections(old, tr),
    },
    props: { decorations: (state) => key.getState(state) },
  });
}

export const NoteDirection = Extension.create({
  name: 'noteDirection',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        dir: { default: 'auto', keepOnSplit: true, parseHTML: () => 'auto', renderHTML: () => ({ dir: 'auto' }) },
      },
    }];
  },
  addProseMirrorPlugins() { return [noteDirectionPlugin()]; },
});

/**
 * The same directions for HTML made from a note outside the editor (print,
 * Save as PDF), where there are no decorations.
 */
export function directHtml(root) {
  for (const el of root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote')) {
    const dir = textDir(el.textContent);
    if (/^(P|H\d)$/.test(el.tagName)) el.setAttribute('dir', 'auto');
    else if (dir) el.setAttribute('dir', dir);
  }
  return root;
}
