/**
 * markdown.js: notes to and from Markdown files with front matter.
 *
 * Pure functions (no DOM, no storage) shared by the importer, the
 * exporter, and the tests. Export and import round-trip: a NoteTrace
 * export imports back with its labels, color, pin, archive, reminder,
 * and dates.
 *
 * Normalized note shape used by every importer:
 *   { title, body_md, kind: 'text'|'checklist', items: [{ text, checked }],
 *     color, pinned, in_tasks, archived, trashed, labels: [name], created_at,
 *     updated_at, reminder_at, reminder_rrule, reminder_tz }
 * Timestamps are 'YYYY-MM-DD HH:MM:SS' UTC or null.
 *
 * Images: an import can carry `files: [path]`, paths inside the imported
 * zip that the importer uploads and attaches. The Markdown form is an image
 * embed with a relative path at the top of the body, which any Markdown app
 * shows and which imports back as an attachment.
 */

export const NOTE_COLORS = ['ember', 'clay', 'amber', 'sand', 'lime', 'moss', 'sage', 'mint', 'sky', 'tide', 'indigo', 'plum', 'orchid', 'rose', 'bark', 'slate'];
const REPEATS = ['daily', 'weekly', 'monthly', 'yearly'];

/** Date (or anything Date.parse understands) to 'YYYY-MM-DD HH:MM:SS' UTC, or null. */
export function toSqlTs(v) {
  if (v == null || v === '') return null;
  let d;
  if (v instanceof Date) d = v;
  else {
    const s = String(v).trim();
    // Bare 'YYYY-MM-DD HH:MM(:SS)' is our own UTC format.
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
    d = new Date(iso);
  }
  const ms = d.getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : null;
}

const sqlToIso = (s) => (s ? String(s).replace(' ', 'T') + 'Z' : null);

/**
 * Plain text to Markdown that renders with the same line breaks: blank
 * lines stay paragraph breaks, single newlines become hard breaks.
 */
export function plainTextToMarkdown(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map(p => p.split('\n').map(l => l.replace(/\s+$/, '')).join('  \n'))
    .filter(p => p.trim())
    .join('\n\n');
}

// ── Front matter ─────────────────────────────────────────────────────

function _scalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v.startsWith('"')) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    const out = [];
    let cur = '', quote = null;
    for (const ch of inner) {
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === ',') { out.push(_scalar(cur)); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(_scalar(cur));
    return out;
  }
  return v;
}

/**
 * Split YAML-style front matter from a Markdown document. Supports the
 * subset note apps write: scalars, quoted strings, inline [lists], and
 * block "- item" lists. Returns { data, body }.
 */
export function parseFrontMatter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = src.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/);
  if (!m) return { data: {}, body: src };
  const data = {};
  let listKey = null;
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s+-\s+(.*)$/) || (listKey && line.match(/^-\s+(.*)$/));
    if (item && listKey) { data[listKey].push(_scalar(item[1])); continue; }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (kv[2].trim() === '') { data[key] = []; listKey = key; }
    else { data[key] = _scalar(kv[2]); listKey = null; }
  }
  return { data, body: src.slice(m[0].length) };
}

function _yamlValue(v) {
  if (Array.isArray(v)) return `[${v.map(x => JSON.stringify(String(x))).join(', ')}]`;
  if (typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v));
}

// ── Import ───────────────────────────────────────────────────────────

const TASK_RE = /^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/;
// A #tag: not a heading ("# Title"), not in the middle of a word or URL.
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;

function _toList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/[,\s]+/);
  return [];
}

function _cleanLabel(name) {
  return String(name || '').replace(/^#/, '').trim().slice(0, 60);
}

/** Inline #tags in a Markdown body, ignoring code spans and fenced code. */
export function inlineTags(md) {
  const text = String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const tags = new Set();
  for (const m of text.matchAll(TAG_RE)) {
    if (/^\d+$/.test(m[2])) continue; // "#1" is a number, not a tag
    tags.add(m[2].replace(/[/-]+$/, ''));
  }
  return [...tags];
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i;

/** Resolve a relative path against the folder of the Markdown file that references it. */
export function resolveRelative(fromFile, rel) {
  const target = decodeURI(String(rel || '').split(/[?#]/)[0]);
  const parts = String(fromFile || '').split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Pull local image embeds out of a Markdown body. Remote images
 * (http, data) stay in the text. Returns { body, files } where files are
 * { path } relative to the zip root, or { name } for Obsidian ![[name]]
 * embeds, which Obsidian resolves by file name anywhere in the vault.
 */
export function extractImageEmbeds(filePath, md) {
  const files = [];
  let body = String(md || '').replace(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, src) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || !IMAGE_EXT_RE.test(src.split(/[?#]/)[0])) return m;
    files.push({ path: resolveRelative(filePath, src) });
    return '';
  });
  body = body.replace(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, (m, name) => {
    if (!IMAGE_EXT_RE.test(name.trim())) return m;
    files.push({ name: name.trim().split('/').pop() });
    return '';
  });
  if (files.length) body = body.replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  return { body, files };
}

// File names that are dates, ids, or "Untitled" don't make good titles.
function _titleFromFilename(path) {
  const base = String(path || '').split('/').pop().replace(/\.(md|markdown|txt)$/i, '').trim();
  if (!base) return '';
  if (/^untitled/i.test(base)) return '';
  if (/^note-\d+-\d{10,}$/i.test(base)) return ''; // Blinko export: note-<id>-<time>
  if (/^[\d\s_:.T-]+Z?$/.test(base)) return '';
  if (/^[0-9a-f-]{16,}$/i.test(base)) return '';
  return base;
}

/**
 * One Markdown or text file to a normalized note, or null when empty.
 * options.tagsToLabels: turn inline #tags into labels (default true).
 */
export function parseMarkdownNote(path, text, { tagsToLabels = true } = {}) {
  const isText = /\.txt$/i.test(path || '');
  const { data, body: rawBody } = isText
    ? { data: {}, body: String(text || '').replace(/\r\n?/g, '\n') }
    : parseFrontMatter(text);
  let body = isText ? plainTextToMarkdown(rawBody) : rawBody.replace(/^\n+/, '').replace(/\s+$/, '');
  let files = [];
  if (!isText) ({ body, files } = extractImageEmbeds(path, body));

  // An explicit title (even an empty one, as NoteTrace exports write for
  // untitled notes) wins over the H1 and file-name fallbacks.
  const explicitTitle = typeof data.title === 'string';
  let title = explicitTitle ? data.title.trim() : '';
  if (!explicitTitle && !isText) {
    const h1 = body.match(/^#\s+(.+?)\s*#*\s*(?:\n|$)/);
    if (h1) { title = h1[1].trim(); body = body.slice(h1[0].length).replace(/^\n+/, ''); }
  }
  if (!title && !explicitTitle) title = _titleFromFilename(path);

  const lines = body.split('\n').filter(l => l.trim());
  const allTasks = lines.length > 0 && lines.every(l => TASK_RE.test(l));
  const kind = data.kind === 'checklist' || allTasks ? 'checklist' : 'text';
  const items = kind === 'checklist'
    ? lines.map(l => {
        const t = l.match(TASK_RE);
        if (t) return { text: t[2].trim(), checked: t[1].toLowerCase() === 'x' };
        return { text: l.replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim(), checked: false };
      }).filter(i => i.text)
    : [];

  const labels = new Set([..._toList(data.labels), ..._toList(data.tags)].map(_cleanLabel).filter(Boolean));
  if (tagsToLabels) for (const t of inlineTags(body)) labels.add(_cleanLabel(t));

  // Blinko's Markdown export has no front matter; its file name carries the creation time.
  const blinkoTime = String(path || '').match(/(?:^|\/)note-\d+-(\d{10,})\.md$/i);
  const created = toSqlTs(data.created ?? data.created_at ?? data.date ?? null)
    || (blinkoTime ? toSqlTs(new Date(Number(blinkoTime[1]))) : null);
  const updated = toSqlTs(data.updated ?? data.updated_at ?? data.modified ?? null) || created;
  const reminderAt = toSqlTs(data.reminder ?? null);

  const note = {
    title: title.slice(0, 1000),
    body_md: kind === 'text' ? body : '',
    kind,
    items,
    color: NOTE_COLORS.includes(data.color) ? data.color : null,
    pinned: data.pinned === true,
    in_tasks: kind === 'checklist' && data.in_tasks === true,
    archived: data.archived === true || /(^|\/)archive\//i.test(path || ''),
    trashed: false,
    labels: [...labels],
    created_at: created,
    updated_at: updated,
    reminder_at: reminderAt,
    reminder_rrule: reminderAt && REPEATS.includes(data.repeat) ? data.repeat : null,
    reminder_tz: reminderAt && typeof data.timezone === 'string' ? data.timezone : null,
  };
  note.files = files;
  if (!note.title && !note.body_md.trim() && !note.items.length && !files.length) return null;
  return note;
}

// ── Export ───────────────────────────────────────────────────────────

/**
 * A note (API shape) to a Markdown document with front matter.
 * `imagePaths` are the note's exported images, relative to the file.
 */
export function noteToMarkdown(note, labelNames = [], imagePaths = []) {
  const fm = [];
  const put = (k, v) => {
    if (v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length)) return;
    fm.push(`${k}: ${_yamlValue(v)}`);
  };
  fm.push(`title: ${_yamlValue(note.title || '')}`);
  if (note.kind === 'checklist') put('kind', 'checklist');
  put('labels', labelNames);
  put('color', note.color);
  put('pinned', !!note.pinned);
  if (note.kind === 'checklist') put('in_tasks', !!note.in_tasks);
  put('archived', !!note.archived);
  if (note.reminder_at) {
    put('reminder', sqlToIso(note.reminder_at));
    put('repeat', note.reminder_rrule);
    put('timezone', note.reminder_tz);
  }
  if (note.share_role && note.share_role !== 'owner') put('shared_by', note.share_owner);
  put('created', sqlToIso(note.created_at));
  put('updated', sqlToIso(note.updated_at));

  const content = note.kind === 'checklist'
    ? (note.items || []).map(i => `- [${i.checked ? 'x' : ' '}] ${String(i.text || '').replace(/\n/g, ' ')}`).join('\n')
    : String(note.body_md || '');
  const images = imagePaths.map(p => `![](${encodeURI(p)})`).join('\n\n');
  const body = images ? (content ? `${images}\n\n${content}` : images) : content;
  return `---\n${fm.join('\n')}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}

/** A safe, unique file name for a note inside a folder. `used` is a Set per folder. */
export function exportFileName(note, used) {
  let base = String(note.title || '')
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  if (!base) base = `Note ${note.id ?? ''}`.trim();
  let name = `${base}.md`;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).md`;
  used.add(name.toLowerCase());
  return name;
}
