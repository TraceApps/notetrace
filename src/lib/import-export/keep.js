/**
 * keep.js: Google Keep notes from a Google Takeout export.
 *
 * Takeout writes one JSON file per note under Takeout/Keep/. Text,
 * checklists, labels, colors, pins, archive, trash, links, and edit
 * dates are imported, photos and drawings come along as images, and voice
 * recordings as voice notes (converted by the server when needed)
 * (`files`, uploaded by the importer). Voice recordings are counted so the
 * summary can say what was left behind.
 */
import { plainTextToMarkdown, toSqlTs } from './markdown.js';

// Keep's colors, each onto its closest NoteTrace color.
export const KEEP_COLORS = {
  RED: 'ember', ORANGE: 'amber', YELLOW: 'sand', GREEN: 'moss',
  TEAL: 'sage', BLUE: 'sky', CERULEAN: 'tide', PURPLE: 'plum',
  PINK: 'rose', BROWN: 'bark', GRAY: 'slate',
};

const usecToTs = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? toSqlTs(new Date(Math.floor(n / 1000))) : null;
};

/** True when a parsed JSON object looks like a Keep note. */
export function isKeepNote(obj) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj)
    && ('textContent' in obj || 'listContent' in obj)
    && ('userEditedTimestampUsec' in obj || 'createdTimestampUsec' in obj || 'isTrashed' in obj);
}

/**
 * One Keep note to { note, attachments }, or null when it isn't a Keep
 * note. `note` is null for a note that only held attachments.
 */
export function parseKeepNote(obj) {
  if (!isKeepNote(obj)) return null;
  const isList = Array.isArray(obj.listContent);
  const items = isList
    ? obj.listContent
        .map(i => ({ text: String(i?.text ?? '').replace(/\s+$/, ''), checked: !!i?.isChecked }))
        .filter(i => i.text.trim())
    : [];
  const text = String(obj.textContent ?? '');
  const links = (Array.isArray(obj.annotations) ? obj.annotations : [])
    .filter(a => a && typeof a.url === 'string' && /^https?:\/\//i.test(a.url) && !text.includes(a.url));

  let body = isList ? '' : plainTextToMarkdown(text);
  if (!isList && links.length) {
    const linkMd = links
      .map(a => (a.title ? `[${String(a.title).replace(/[[\]]/g, '')}](${a.url})` : a.url))
      .join('  \n');
    body = body ? `${body}\n\n${linkMd}` : linkMd;
  }
  // A checklist has no body, so its links become unchecked items.
  const listLinks = isList ? links.map(a => ({ text: a.url, checked: false })) : [];

  const updated = usecToTs(obj.userEditedTimestampUsec);
  const created = usecToTs(obj.createdTimestampUsec) || updated;
  const all = Array.isArray(obj.attachments) ? obj.attachments : [];
  // Photos, drawings, voice recordings, and any other file come along; only an
  // entry with no file to read is counted as left out.
  const kept = all.filter(a => typeof a?.filePath === 'string' && a.filePath);
  const attachments = all.length - kept.length;
  const note = {
    title: String(obj.title ?? '').trim().slice(0, 1000),
    body_md: body,
    kind: isList ? 'checklist' : 'text',
    items: [...items, ...listLinks],
    color: KEEP_COLORS[String(obj.color || '').toUpperCase()] || null,
    pinned: !!obj.isPinned && !obj.isArchived && !obj.isTrashed,
    archived: !!obj.isArchived,
    trashed: !!obj.isTrashed,
    labels: (Array.isArray(obj.labels) ? obj.labels : [])
      .map(l => String(l?.name ?? '').trim().slice(0, 60))
      .filter(Boolean),
    created_at: created,
    updated_at: updated || created,
    reminder_at: null,
    reminder_rrule: null,
    reminder_tz: null,
    files: kept.map(a => ({ name: a.filePath.split('/').pop(), ...(a.mimetype && !/^image\//i.test(a.mimetype) ? { mime: String(a.mimetype).toLowerCase() } : {}) })),
  };
  const empty = !note.title && !note.body_md.trim() && !note.items.length && !note.files.length;
  return { note: empty ? null : note, attachments };
}
