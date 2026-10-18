/**
 * note-table.js: tables in text notes (TraceApps/notetrace#26).
 *
 * A table is saved as a Markdown table (GitHub's `| a | b |` form), so notes
 * stay plain, portable text that Obsidian and other apps read too. Markdown
 * can only hold some tables, so the editor keeps every table in that shape,
 * and a note reloads exactly as it was saved:
 *
 * - a cell is one paragraph (bold, links, code and the rest still work), its
 *   line breaks (Shift+Enter) saved as <br>, as GitHub and Obsidian write
 *   them; Enter moves to the cell below,
 * - the first row is the header row, and only the first row,
 * - no merged cells and no column widths (a pasted table loses them),
 * - each column has one alignment.
 *
 * A `|` typed in a cell is escaped when saved, so it stays in its cell.
 */
import { Table, TableRow, TableHeader, TableCell, renderTableToMarkdown } from '@tiptap/extension-table';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';

/** Escape the `|` in a cell's Markdown that isn't escaped already or inside a code span. */
export function escapeCellPipes(md) {
  let out = '';
  for (let i = 0; i < md.length;) {
    const c = md[i];
    if (c === '\\' && i + 1 < md.length) { out += md.slice(i, i + 2); i += 2; continue; }
    if (c === '`') {
      let run = 0;
      while (md[i + run] === '`') run++;
      const close = md.indexOf('`'.repeat(run), i + run);
      // A code span keeps its pipes; reading a table escapes them itself.
      if (close >= 0 && md[close + run] !== '`') { out += md.slice(i, close + run); i = close + run; continue; }
      out += md.slice(i, i + run); i += run; continue;
    }
    out += c === '|' ? '\\|' : c;
    i++;
  }
  return out;
}

const CELLS = new Set(['tableCell', 'tableHeader']);

/** Changes that put every table in the shape Markdown holds, or null when they all are. */
export function normalizeTables(state) {
  const { tableHeader, tableCell } = state.schema.nodes;
  let tr = null;
  state.doc.descendants((table, pos) => {
    // Tables sit among blocks: no need to look inside a paragraph's text.
    if (table.type.name !== 'table') return !table.isTextblock;
    // Each column's alignment, picked the way the Markdown is written.
    const aligns = [];
    table.forEach((row) => row.forEach((cell, _o, c) => { if (aligns[c] == null && cell.attrs.align) aligns[c] = cell.attrs.align; }));
    table.forEach((row, rowOffset, r) => {
      row.forEach((cell, cellOffset, c) => {
        const at = pos + 1 + rowOffset + 1 + cellOffset;
        const type = r === 0 ? tableHeader : tableCell;
        const align = aligns[c] ?? null;
        const { colspan, rowspan, colwidth } = cell.attrs;
        // Nothing here changes a size, so the positions found stay right.
        if (cell.type !== type || colspan !== 1 || rowspan !== 1 || colwidth != null || cell.attrs.align !== align) {
          (tr ||= state.tr).setNodeMarkup(at, type, { ...cell.attrs, colspan: 1, rowspan: 1, colwidth: null, align });
        }
      });
    });
    return false;
  });
  return tr;
}

/** Where the cursor is in a table: the table, where it starts, its map and the cell's rectangle. */
function cellAt(state) {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 2; d--) {
    if (!CELLS.has($from.node(d).type.name)) continue;
    const table = $from.node(d - 2);
    const start = $from.start(d - 2);
    const map = TableMap.get(table);
    return { table, start, map, rect: map.findCell($from.before(d) - start), row: $from.node(d - 1), rowStart: $from.before(d - 1) };
  }
  return null;
}

/** The cursor at the end of the cell at (row, col). */
function intoCell(tr, at, row, col) {
  const { table, start, map } = at;
  const pos = start + map.positionAt(row, col, table);
  const cell = tr.doc.nodeAt(pos);
  return tr.setSelection(TextSelection.create(tr.doc, pos + cell.nodeSize - 2));
}

/** A row with nothing in it: no text but spaces, and no link chip or line break. */
function isEmptyRow(row) {
  let empty = true;
  row.descendants((n) => { if (n.isInline && !(n.isText && !n.text.trim())) empty = false; return empty; });
  return empty;
}

/**
 * Enter in a cell moves down a row, adding one at the bottom. Enter in an
 * empty last row takes that row away and leaves the table, as an empty list
 * item leaves its list.
 */
function enterInCell(editor) {
  const { state } = editor;
  const at = cellAt(state);
  if (!at) return false;
  const { map, rect, table, start } = at;
  if (rect.bottom < map.height) {
    editor.view.dispatch(intoCell(state.tr, at, rect.bottom, rect.left).scrollIntoView());
    return true;
  }
  if (map.height > 1 && isEmptyRow(at.row)) {
    const tableEnd = start + table.content.size + 1;
    let tr = state.tr.delete(at.rowStart, at.rowStart + at.row.nodeSize);
    const after = tr.mapping.map(tableEnd);
    if (!tr.doc.nodeAt(after)?.isTextblock) tr = tr.insert(after, state.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    editor.view.dispatch(tr.scrollIntoView());
    return true;
  }
  return addRowBelow(editor);
}

/** A row below the cursor's, with the cursor moved into it, ready to type. */
export function addRowBelow(editor) {
  const at = cellAt(editor.state);
  if (!at || !editor.commands.addRowAfter()) return false;
  const next = cellAt(editor.state);
  if (next) editor.view.dispatch(intoCell(editor.state.tr, next, at.rect.bottom, at.rect.left).scrollIntoView());
  return true;
}

/** A column right of the cursor's, with the cursor moved into it. */
export function addColumnRight(editor) {
  const at = cellAt(editor.state);
  if (!at || !editor.commands.addColumnAfter()) return false;
  const next = cellAt(editor.state);
  if (next) editor.view.dispatch(intoCell(editor.state.tr, next, at.rect.top, at.rect.right).scrollIntoView());
  return true;
}

const BLOCKS = 'p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, pre, table, caption, thead, tbody, tfoot, tr, td, th';
const span = (cell, name, most) => Math.max(1, Math.min(Number(cell.getAttribute(name)) || 1, most));

/** A merged cell becomes that many cells, the extra ones empty, so every column keeps its place. */
function splitMerged(doc, table) {
  const rows = [...table.rows];
  const taken = rows.map(() => new Set()); // columns filled from a cell merged down from above
  rows.forEach((row, r) => {
    let col = 0;
    const fill = (before) => {
      while (taken[r].has(col)) { row.insertBefore(doc.createElement('td'), before); col++; }
    };
    for (const cell of [...row.cells]) {
      fill(cell);
      const across = span(cell, 'colspan', 50), down = span(cell, 'rowspan', rows.length - r);
      for (let k = 1; k < down; k++) for (let c = col; c < col + across; c++) taken[r + k].add(c);
      cell.removeAttribute('colspan');
      cell.removeAttribute('rowspan');
      for (let i = 1; i < across; i++) cell.after(doc.createElement(cell.tagName));
      col += across;
    }
    fill(null);
  });
}

/**
 * A table pasted from a web page or a document, put in the shape a cell can
 * hold before the editor reads it: each cell's paragraphs and list items
 * become lines in one paragraph, and a merged cell becomes that many cells.
 * Left as it was, a list in a cell would break the table in two around it.
 */
export function flattenPastedTables(html) {
  if (!/<table/i.test(html) || typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const table of doc.querySelectorAll('table')) splitMerged(doc, table);
  // Innermost cells first, so a table inside a cell (an email's layout) runs into its cell.
  for (const cell of [...doc.querySelectorAll('td, th')].reverse()) {
    // Innermost blocks first, each one ending its line.
    for (const block of [...cell.querySelectorAll(BLOCKS)].reverse()) block.replaceWith(...block.childNodes, doc.createElement('br'));
    // One break between lines, none at the start or the end.
    const nodes = [...cell.childNodes];
    let seenText = false, lastBr = null;
    for (const n of nodes) {
      const blank = n.nodeType === 3 && !n.textContent.trim();
      if (n.nodeName === 'BR') {
        if (!seenText || lastBr) n.remove(); else lastBr = n;
      } else if (!blank) { seenText = true; lastBr = null; }
    }
    if (lastBr) lastBr.remove();
  }
  return doc.body.innerHTML;
}

const normalizeKey = new PluginKey('noteTableShape');

/** Keeps every table in the shape Markdown holds after each change, and flattens pasted tables. */
export function tableShapePlugin() {
  return new Plugin({
    key: normalizeKey,
    appendTransaction: (trs, _old, state) => (trs.some((t) => t.docChanged) ? normalizeTables(state) : null),
    props: { transformPastedHTML: flattenPastedTables },
  });
}

// A <br> in a cell is a line break: GitHub, Obsidian and the writer below put one there.
const BR = /^<br\s*\/?>$/i;
const brAsBreak = (tokens) => (tokens || []).map((t) => (t.type === 'html' && BR.test(t.raw.trim()) ? { type: 'br', raw: t.raw } : t));

export const NoteTable = Table.extend({
  // Writes the table the package's way, with each cell's `|` escaped. At the
  // top of a note or in a quote it adds no blank line of its own; in a list
  // item it keeps the one before it, or the table would read as the item's text.
  renderMarkdown(node, h, ctx) {
    const helpers = Object.create(h);
    helpers.renderChildren = (...args) => escapeCellPipes(h.renderChildren(...args));
    const out = renderTableToMarkdown(node, helpers).replace(/\n+$/, '');
    return ctx?.parentType === 'doc' || ctx?.parentType === 'blockquote' ? out.replace(/^\n+/, '') : out;
  },
  parseMarkdown(token, h) {
    const cells = (list) => (list || []).map((c) => ({ ...c, tokens: brAsBreak(c.tokens) }));
    return this.parent({ ...token, header: cells(token.header), rows: (token.rows || []).map(cells) }, h);
  },
  // The package's start() would claim a table where a paragraph merely has a
  // | in its first line, splitting that paragraph into single letters. Tables
  // are still found where they begin, by this tokenizer and by marked's own.
  markdownTokenizer: { ...Table.config.markdownTokenizer, start: () => -1 },
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      // Shift+Enter stays a line break in the cell.
      Enter: () => enterInCell(this.editor),
    };
  },
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() || []),
      tableShapePlugin(),
    ];
  },
}).configure({ resizable: false, allowTableNodeSelection: false });

// One paragraph per cell: Markdown has nowhere to keep a second line.
export const NoteTableHeader = TableHeader.extend({ content: 'paragraph' });
export const NoteTableCell = TableCell.extend({ content: 'paragraph' });

/** Everything a note's tables need, for the editor and for printing. */
export const NoteTables = [NoteTable, TableRow, NoteTableHeader, NoteTableCell];

/** Whether the cursor is in a table. */
export const inTable = (state) => !!cellAt(state);
