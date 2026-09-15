/**
 * note-filters.js: the filter chips under search. Pure, so it's testable.
 *
 * Filters combine across groups (a type AND a color AND a label) and any
 * choice within a group matches (Lists OR Images).
 */
export const FILTER_TYPES = [
  { key: 'checklist', icon: 'checklist',       label: 'filters.lists' },
  { key: 'text',      icon: 'notes',           label: 'filters.text' },
  { key: 'images',    icon: 'image',           label: 'filters.images' },
  { key: 'voice',     icon: 'mic',             label: 'filters.voice' },
  { key: 'reminders', icon: 'notifications',   label: 'filters.reminders' },
  { key: 'shared',    icon: 'group',           label: 'filters.shared' },
  { key: 'links',     icon: 'link',            label: 'filters.links' },
];

const URL_RE = /\bhttps?:\/\/[^\s<>()]+/i;
const isAudio = (a) => /^audio\//i.test(String(a?.mime || '')) || /\.(webm|ogg|m4a|mp3|wav|aac)$/i.test(String(a?.url || ''));

const TYPE_TESTS = {
  checklist: (n) => n.kind === 'checklist',
  text:      (n) => n.kind !== 'checklist',
  images:    (n) => (n.attachments || []).some(a => !isAudio(a)),
  voice:     (n) => (n.attachments || []).some(isAudio),
  reminders: (n) => !!n.reminder_at,
  shared:    (n) => (n.share_count || 0) > 0 || (!!n.share_role && n.share_role !== 'owner'),
  links:     (n) => URL_RE.test(n.title || '') || URL_RE.test(n.body_md || '') || (n.items || []).some(i => URL_RE.test(i.text || '')),
};

export function emptyFilters() {
  return { types: [], colors: [], labels: [] };
}

export function hasFilters(f) {
  return !!f && (f.types.length + f.colors.length + f.labels.length) > 0;
}

export function matchesFilters(note, f) {
  if (!hasFilters(f)) return true;
  if (f.types.length && !f.types.some(t => TYPE_TESTS[t]?.(note))) return false;
  if (f.colors.length && !f.colors.includes(note.color || null)) return false;
  if (f.labels.length && !f.labels.some(id => (note.labels || []).includes(id))) return false;
  return true;
}

/** Toggle a value in one group, returning a new filters object. */
export function toggleFilter(f, group, value) {
  const list = f[group].includes(value) ? f[group].filter(v => v !== value) : [...f[group], value];
  return { ...f, [group]: list };
}
