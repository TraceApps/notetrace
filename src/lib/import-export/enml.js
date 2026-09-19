/**
 * enml.js: Evernote note content (ENML, an XHTML dialect) to Markdown.
 *
 * Works on a parsed DOM tree (the browser's DOMParser, or @xmldom/xmldom in
 * tests), so it only uses nodeType, nodeName, childNodes, getAttribute, and
 * nodeValue.
 *
 * Evernote lays notes out as one <div> per line, so each block becomes its
 * own line: consecutive lines are joined with Markdown hard breaks and empty
 * <div><br/></div> lines become paragraph breaks, which keeps the note
 * looking the way it did in Evernote. Checkboxes come in two forms, legacy
 * <en-todo checked="true"/> and Evernote 10's <ul style="--en-todo:true">
 * lists; both become `- [ ]` / `- [x]`. Attachments (<en-media hash="...">)
 * are collected rather than written, since images go on the note itself.
 */

const BLOCK = new Set(['div', 'p', 'section', 'article', 'header', 'footer', 'center', 'en-note', 'body', 'html', 'address', 'figure', 'figcaption', 'dl', 'dt', 'dd']);
const HEADING = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const SKIP = new Set(['head', 'style', 'script', 'title', 'meta', 'link', 'object', 'embed', 'iframe']);

const name = (n) => String(n.nodeName || '').toLowerCase();
const attr = (n, a) => (n.getAttribute ? n.getAttribute(a) : null) || '';
const kids = (n) => Array.from(n.childNodes || []);

/** Escape characters Markdown would read as formatting. */
function esc(text) {
  return text.replace(/([\\`*_~[\]])/g, '\\$1');
}

/** Line-start characters that would turn a plain line into a heading, quote, or list. */
function escLineStart(line) {
  return line.replace(/^(\s*)(#{1,6}\s|>|[-+]\s|\d+[.)]\s)/, (m, sp, mark) => `${sp}\\${mark}`);
}

function styleHas(n, re) {
  return re.test(attr(n, 'style'));
}

/**
 * Convert an <en-note> (or any element) to Markdown.
 * Returns { markdown, todos, onlyTodos, mediaHashes, inlineImages }.
 */
export function enmlToMarkdown(root) {
  const lines = [];          // { kind: 'text'|'blank'|'todo'|'heading'|'li'|'quote'|'code'|'hr'|'row', text, ... }
  const mediaHashes = [];
  const inlineImages = [];   // data: URLs from <img> tags
  let buf = '';
  let pendingTodo = null;    // checked state of an en-todo that starts the current line

  function flush(extra = {}) {
    const text = buf.replace(/[ \t]+/g, ' ').trim();
    buf = '';
    if (pendingTodo !== null) {
      lines.push({ kind: 'todo', text, checked: pendingTodo, ...extra });
      pendingTodo = null;
      return;
    }
    if (extra.kind) { lines.push({ ...extra, text }); return; }
    if (text) lines.push({ kind: 'text', text });
    return text;
  }

  function inline(n, marks) {
    for (const c of kids(n)) walk(c, marks);
  }

  function wrap(n, marks, open, close = open) {
    const before = buf.length;
    inline(n, marks);
    const inner = buf.slice(before);
    if (!inner.trim()) return;
    // Keep surrounding spaces outside the markers, or Markdown won't read them.
    const lead = inner.match(/^\s*/)[0];
    const trail = inner.match(/\s*$/)[0];
    buf = buf.slice(0, before) + lead + open + inner.trim() + close + trail;
  }

  function walk(n, marks = {}) {
    if (n.nodeType === 3) { // text
      buf += marks.pre ? n.nodeValue : esc(String(n.nodeValue || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' '));
      return;
    }
    if (n.nodeType !== 1) return;
    const tag = name(n);
    if (SKIP.has(tag)) return;

    if (tag === 'en-media') {
      const hash = attr(n, 'hash').toLowerCase();
      if (hash) mediaHashes.push(hash);
      return;
    }
    if (tag === 'img') {
      const src = attr(n, 'src');
      if (/^data:image\//i.test(src)) inlineImages.push(src);
      else if (/^https?:\/\//i.test(src)) buf += `[${esc(attr(n, 'alt') || 'image')}](${src})`;
      return;
    }
    if (tag === 'en-todo') {
      if (buf.trim()) flush();
      pendingTodo = attr(n, 'checked') === 'true';
      return;
    }
    if (tag === 'en-crypt') { buf += '(encrypted text not imported)'; return; }
    if (tag === 'br') { if (buf.trim() || pendingTodo !== null) flush(); else lines.push({ kind: 'blank' }); return; }
    if (tag === 'hr') { flush(); lines.push({ kind: 'hr' }); return; }

    if (tag in HEADING) { flush(); inline(n, marks); flush({ kind: 'heading', level: HEADING[tag] }); return; }
    if (tag === 'blockquote') {
      flush();
      const start = lines.length;
      inline(n, marks);
      flush();
      for (let i = start; i < lines.length; i++) if (lines[i].kind === 'text') lines[i].kind = 'quote';
      return;
    }
    if (tag === 'pre') {
      flush();
      inline(n, { ...marks, pre: true });
      const code = buf;
      buf = '';
      lines.push({ kind: 'code', text: code.replace(/\n+$/, '') });
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      flush();
      const depth = (marks.depth ?? -1) + 1;
      const todoList = styleHas(n, /--en-todo\s*:\s*true/i);
      let index = 0;
      for (const li of kids(n)) {
        if (li.nodeType !== 1) continue;
        if (name(li) !== 'li') { walk(li, { ...marks, depth }); continue; }
        index++;
        // Nested lists inside the item render after its own text.
        const nested = kids(li).filter(c => c.nodeType === 1 && (name(c) === 'ul' || name(c) === 'ol'));
        // Blocks inside an item (Evernote 10 wraps item text in <div>) are part of the item.
        for (const c of kids(li)) if (!nested.includes(c)) walk(c, { ...marks, depth, inItem: true });
        if (todoList) {
          pendingTodo = styleHas(li, /--en-checked\s*:\s*true/i);
          flush({ depth });
        } else if (pendingTodo !== null) {
          flush({ depth });
        } else {
          flush({ kind: 'li', depth, ordered: tag === 'ol', index });
        }
        for (const c of nested) walk(c, { ...marks, depth, inItem: false });
      }
      return;
    }
    if (tag === 'table') {
      flush();
      const rows = [];
      const collect = (el) => { for (const c of kids(el)) { if (c.nodeType !== 1) continue; if (name(c) === 'tr') rows.push(c); else collect(c); } };
      collect(n);
      for (const tr of rows) {
        const cells = kids(tr).filter(c => c.nodeType === 1 && /^t[dh]$/.test(name(c))).map(td => {
          inline(td, marks);
          const t = buf.replace(/\s+/g, ' ').trim();
          buf = '';
          return t;
        });
        if (cells.some(Boolean)) lines.push({ kind: 'row', text: cells.join(' | ') });
      }
      return;
    }
    if (tag === 'b' || tag === 'strong' || (tag === 'span' && styleHas(n, /font-weight\s*:\s*(bold|[6-9]00)/i))) return wrap(n, marks, '**');
    if (tag === 'i' || tag === 'em' || (tag === 'span' && styleHas(n, /font-style\s*:\s*italic/i))) return wrap(n, marks, '*');
    if (tag === 's' || tag === 'strike' || tag === 'del' || (tag === 'span' && styleHas(n, /line-through/i))) return wrap(n, marks, '~~');
    if (tag === 'code' && !marks.pre) {
      const before = buf.length;
      inline(n, { ...marks, pre: true });
      const inner = buf.slice(before);
      buf = buf.slice(0, before) + (inner.trim() ? `\`${inner.replace(/`/g, "'")}\`` : '');
      return;
    }
    if (tag === 'a') {
      const href = attr(n, 'href');
      const before = buf.length;
      inline(n, marks);
      const inner = buf.slice(before).trim();
      if (/^(https?:|mailto:)/i.test(href)) {
        buf = buf.slice(0, before) + (inner && inner !== esc(href) ? `[${inner}](${href})` : href);
      }
      return;
    }
    if ((BLOCK.has(tag) || tag === 'li') && marks.inItem) {
      if (buf.trim()) buf += ' ';
      inline(n, marks);
      return;
    }
    if (BLOCK.has(tag) || tag === 'li') {
      if (buf.trim() || pendingTodo !== null) flush();
      const start = lines.length;
      inline(n, marks);
      const text = flush();
      // An empty block (<div></div> or <div><br/></div>) is a blank line.
      if (lines.length === start && !text) lines.push({ kind: 'blank' });
      return;
    }
    inline(n, marks); // span, font, u, sup, sub, and anything unknown: keep the text
  }

  walk(root);
  flush();

  // Assemble: plain lines join with hard breaks, blanks separate paragraphs.
  const out = [];
  let para = [];
  const endPara = () => { if (para.length) { out.push(para.join('  \n')); para = []; } };
  let prevKind = null;
  for (const l of lines) {
    if (l.kind === 'blank') { endPara(); prevKind = 'blank'; continue; }
    if (l.kind === 'text') {
      if (prevKind && prevKind !== 'text' && prevKind !== 'blank') endPara();
      para.push(escLineStart(l.text));
      prevKind = 'text';
      continue;
    }
    endPara();
    const indent = '  '.repeat(l.depth || 0);
    let md;
    if (l.kind === 'heading') md = `${'#'.repeat(l.level)} ${l.text}`;
    else if (l.kind === 'todo') md = `${indent}- [${l.checked ? 'x' : ' '}] ${l.text}`;
    else if (l.kind === 'li') md = `${indent}${l.ordered ? `${l.index}.` : '-'} ${l.text}`;
    else if (l.kind === 'quote') md = `> ${l.text}`;
    else if (l.kind === 'code') md = '```\n' + l.text + '\n```';
    else if (l.kind === 'hr') md = '---';
    else md = l.text; // table row
    // Lists and todos stay together; other blocks get their own paragraph.
    const listy = (k) => k === 'todo' || k === 'li';
    if (out.length && listy(l.kind) && listy(prevKind)) out[out.length - 1] += `\n${md}`;
    else if (out.length && l.kind === 'row' && prevKind === 'row') out[out.length - 1] += `  \n${md}`;
    else out.push(md);
    prevKind = l.kind;
  }
  endPara();

  const todos = lines.filter(l => l.kind === 'todo').map(l => ({ text: l.text.replace(/\\([\\`*_~[\]])/g, '$1'), checked: !!l.checked }));
  const content = lines.filter(l => l.kind !== 'blank');
  const onlyTodos = todos.length > 0 && content.every(l => l.kind === 'todo');
  return { markdown: out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(), todos, onlyTodos, mediaHashes, inlineImages };
}
