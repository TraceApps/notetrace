/**
 * note-templates.js: notes to start from. A template keeps a note's shape (its
 * kind, title, text or list items, and colour) but not its pictures, files,
 * labels, or reminder, and lives in the synced `noteTemplates` setting, so it
 * travels between devices and never turns up among notes, in search, Tasks, or
 * reminders.
 *
 * Tokens in a template's title, text, or items fill in when a note is made
 * from it: {date}, {time}, and {weekday}.
 */

export const MAX_TEMPLATES = 50;
export const MAX_NAME = 80;
export const MAX_TITLE = 500;
export const MAX_BODY = 50_000;
export const MAX_ITEMS = 300;
export const MAX_ITEM_TEXT = 2_000;

const _id = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
const _str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);

/** One template, cleaned; null when there's nothing usable in it. */
export function cleanTemplate(t) {
  if (!t || typeof t !== 'object') return null;
  const kind = t.kind === 'checklist' ? 'checklist' : 'text';
  const items = kind === 'checklist' && Array.isArray(t.items)
    ? t.items.map(i => _str(typeof i === 'string' ? i : i?.text, MAX_ITEM_TEXT)).filter(s => s.trim()).slice(0, MAX_ITEMS)
    : [];
  const out = {
    id: _str(t.id, 64) || _id(),
    name: _str(t.name, MAX_NAME).trim(),
    kind,
    title: _str(t.title, MAX_TITLE),
    body_md: kind === 'text' ? _str(t.body_md, MAX_BODY) : '',
    items,
    color: typeof t.color === 'string' && /^[a-z]{1,20}$/.test(t.color) ? t.color : null,
  };
  if (!out.name) out.name = out.title.trim().slice(0, MAX_NAME);
  if (!out.name) return null;
  return out;
}

/** The saved list, cleaned: at most MAX_TEMPLATES, no repeated ids. */
export function cleanTemplates(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const c = cleanTemplate(t);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= MAX_TEMPLATES) break;
  }
  return out;
}

/** A template from a note (checked items come along unchecked). */
export function templateFromNote(note, name) {
  return cleanTemplate({
    id: _id(),
    name: name || note?.title,
    kind: note?.kind,
    title: note?.title,
    body_md: note?.body_md,
    items: [...(note?.items || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(i => i.text),
    color: note?.color,
  });
}

/** Whether a note has anything worth keeping as a template. */
export function canTemplate(note) {
  if (!note) return false;
  if (String(note.title || '').trim()) return true;
  return note.kind === 'checklist'
    ? (note.items || []).some(i => String(i.text || '').trim())
    : !!String(note.body_md || '').trim();
}

/** {date}, {time}, and {weekday} filled in for `now`. */
export function fillTokens(s, now = new Date(), { formatDate = (d) => d.toLocaleDateString(), locale } = {}) {
  if (!s || !s.includes('{')) return s || '';
  return s
    .replace(/\{date\}/gi, () => formatDate(now))
    .replace(/\{time\}/gi, () => now.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }))
    .replace(/\{weekday\}/gi, () => now.toLocaleDateString(locale, { weekday: 'long' }));
}

/** What a new note from a template starts with (the editor's `prefill`). */
export function noteFromTemplate(template, { now = new Date(), formatDate, locale } = {}) {
  const t = cleanTemplate(template);
  if (!t) return null;
  const fill = (s) => fillTokens(s, now, { formatDate, locale });
  return {
    kind: t.kind,
    title: fill(t.title),
    body_md: t.kind === 'text' ? fill(t.body_md) : '',
    items: t.kind === 'checklist'
      ? t.items.map((text, i) => ({ uuid: _id(), id: null, text: fill(text), checked: false, position: i + 1 }))
      : [],
    color: t.color,
  };
}
