/**
 * evernote.js: notes from Evernote export files (.enex).
 *
 * Evernote exports a notebook as one .enex XML file: each <note> carries its
 * title, dates, tags, source URL and reminder attributes, the body as ENML
 * (converted by enml.js), and its attachments as base64 <resource> data.
 * Images become images on the note, matched to the body by the MD5 hash the
 * body uses to refer to them; other attachments (PDFs, audio) are counted.
 * Evernote 10 tasks (<task>) become checklist items.
 *
 * `parseXml(text, mime)` is injected so the same code runs on the browser's
 * DOMParser and on @xmldom/xmldom in tests. Notes are parsed one at a time,
 * so a large export never becomes one giant DOM.
 */
import { enmlToMarkdown } from './enml.js';
import { md5Hex, base64ToBytes } from './md5.js';
import { toSqlTs } from './markdown.js';

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif' };

/** Evernote's compact timestamps (20230115T103000Z) to 'YYYY-MM-DD HH:MM:SS' UTC. */
export function enexDate(s) {
  const m = String(s || '').trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : toSqlTs(s);
}

const text = (el) => (el ? String(el.textContent || '') : '');
const child = (el, tag) => {
  for (const c of Array.from(el?.childNodes || [])) if (c.nodeType === 1 && String(c.nodeName).toLowerCase() === tag) return c;
  return null;
};
const children = (el, tag) => Array.from(el?.childNodes || []).filter(c => c.nodeType === 1 && String(c.nodeName).toLowerCase() === tag);

/** Make ENML parse the same in lenient HTML mode: self-closing custom tags would otherwise swallow the text after them. */
function prepareEnml(enml) {
  return String(enml || '')
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<(en-todo|en-media|en-crypt)\b([^>]*?)\/>/gi, '<$1$2></$1>');
}

/**
 * Parse one <note> element. Returns { note, otherFiles } or null.
 * options: { parseXml, notebook, labelNotebook, now }
 */
export function parseEnexNote(noteEl, { parseXml, notebook = '', labelNotebook = true, now = Date.now() } = {}) {
  const title = text(child(noteEl, 'title')).trim();
  const contentXml = text(child(noteEl, 'content'));
  let converted = { markdown: '', todos: [], onlyTodos: false, mediaHashes: [], inlineImages: [] };
  if (contentXml.trim()) {
    const doc = parseXml(`<html><body>${prepareEnml(contentXml)}</body></html>`, 'text/html');
    const root = doc.getElementsByTagName('en-note')[0] || doc.getElementsByTagName('body')[0] || doc.documentElement;
    converted = enmlToMarkdown(root);
  }

  // Attachments, keyed by the hash the body uses.
  const resources = [];
  for (const r of children(noteEl, 'resource')) {
    const mime = text(child(r, 'mime')).trim().toLowerCase();
    const data = text(child(r, 'data'));
    if (!data.trim()) continue;
    const attrs = child(r, 'resource-attributes');
    const fileName = text(child(attrs, 'file-name')).trim();
    const isImage = IMAGE_MIME.test(mime);
    const res = { mime, data, isImage, name: fileName || (isImage ? `image.${EXT[mime] || 'img'}` : 'attachment') };
    if (isImage) res.hash = md5Hex(base64ToBytes(data));
    res.width = Number(text(child(r, 'width'))) || null;
    res.height = Number(text(child(r, 'height'))) || null;
    resources.push(res);
  }
  // Images in the order the body shows them, then any the body doesn't reference.
  const images = [];
  const used = new Set();
  for (const h of converted.mediaHashes) {
    const r = resources.find(x => x.isImage && x.hash === h && !used.has(x));
    if (r) { used.add(r); images.push(r); }
  }
  for (const r of resources) if (r.isImage && !used.has(r)) images.push(r);
  converted.inlineImages.forEach((src, i) => {
    const m = src.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
    if (m) images.push({ mime: m[1].toLowerCase(), data: m[2], name: `inline-${i + 1}.${EXT[m[1].toLowerCase()] || 'img'}` });
  });
  // Everything that isn't a picture (PDFs, documents, recordings) comes along as a file.
  const otherFiles = 0;
  const attachedFiles = resources.filter(r => !r.isImage).map(r => ({ data: r.data, mime: r.mime || 'application/octet-stream', name: r.name }));

  // Evernote 10 tasks live next to the content.
  const tasks = children(noteEl, 'task').map(t => ({
    text: text(child(t, 'title')).trim(),
    checked: /completed/i.test(text(child(t, 'taskstatus')) || text(child(t, 'taskStatus'))),
  })).filter(t => t.text);

  const attrs = child(noteEl, 'note-attributes');
  const source = text(child(attrs, 'source-url')).trim();
  let markdown = converted.markdown;
  let kind = 'text';
  let items = [];
  if (converted.onlyTodos) {
    kind = 'checklist';
    items = [...converted.todos, ...tasks];
    markdown = '';
  } else if (tasks.length) {
    const lines = tasks.map(t => `- [${t.checked ? 'x' : ' '}] ${t.text.replace(/([\\`*_~[\]])/g, '\\$1')}`).join('\n');
    markdown = markdown ? `${markdown}\n\n${lines}` : lines;
  }
  if (/^https?:\/\//i.test(source) && !markdown.includes(source)) {
    if (kind === 'checklist') items.push({ text: source, checked: false });
    else markdown = markdown ? `${markdown}\n\n${source}` : source;
  }

  if (!title && !markdown.trim() && !items.length && !images.length) return null;

  // A reminder that's still ahead and not marked done carries over.
  const reminder = enexDate(text(child(attrs, 'reminder-time')));
  const reminderDone = text(child(attrs, 'reminder-done-time')).trim();
  const reminderMs = reminder ? Date.parse(reminder.replace(' ', 'T') + 'Z') : NaN;
  const keepReminder = reminder && !reminderDone && Number.isFinite(reminderMs) && reminderMs > now;

  const labels = children(noteEl, 'tag').map(t => text(t).trim().slice(0, 60)).filter(Boolean);
  const nb = String(notebook || '').trim().slice(0, 60);
  if (labelNotebook && nb && !labels.some(l => l.toLowerCase() === nb.toLowerCase())) labels.push(nb);

  const created = enexDate(text(child(noteEl, 'created')));
  return {
    note: {
      title: title.slice(0, 1000),
      body_md: markdown,
      kind,
      items,
      color: null,
      pinned: false,
      archived: false,
      trashed: false,
      labels,
      created_at: created,
      updated_at: enexDate(text(child(noteEl, 'updated'))) || created,
      reminder_at: keepReminder ? reminder : null,
      reminder_rrule: null,
      reminder_tz: null,
      files: [...images.map(r => ({ data: r.data, mime: r.mime, name: r.name })), ...attachedFiles],
    },
    otherFiles,
  };
}

/**
 * Parse a whole .enex file. `notebook` is usually the file name, which is
 * what Evernote names the export after.
 * Returns { notes, attachments, unreadable }.
 */
export function parseEnex(xmlText, options = {}) {
  const notes = [];
  let attachments = 0, unreadable = 0;
  const src = String(xmlText || '');
  const re = /<note>[\s\S]*?<\/note>/g;
  let m;
  while ((m = re.exec(src))) {
    try {
      const doc = options.parseXml(m[0], 'application/xml');
      const el = doc.documentElement;
      if (!el || String(el.nodeName).toLowerCase() !== 'note' || doc.getElementsByTagName('parsererror').length) { unreadable++; continue; }
      const r = parseEnexNote(el, options);
      if (!r) continue;
      attachments += r.otherFiles;
      notes.push(r.note);
    } catch {
      unreadable++;
    }
  }
  return { notes, attachments, unreadable };
}

/** Notebook name from an export file name ("Recipes.enex" becomes "Recipes"). */
export function notebookFromFileName(path) {
  const base = String(path || '').split('/').pop().replace(/\.enex$/i, '').trim();
  return /^(my notes|export|evernote)$/i.test(base) ? '' : base;
}
