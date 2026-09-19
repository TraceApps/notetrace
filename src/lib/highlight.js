/**
 * highlight.js: showing where a search matched. Pure, and tested.
 *
 * Search matches word beginnings (the same rule the server's full-text index
 * uses), so "jelly" highlights "Jellyfin".
 */
export function searchTerms(query) {
  return String(query || '').toLowerCase().split(/[\s,.;:!?"'()[\]{}]+/).map(t => t.trim()).filter(t => t.length > 1).slice(0, 8);
}

const _escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text split into { text, hit } pieces, so a component can mark the hits. */
export function highlightParts(text, terms) {
  const s = String(text ?? '');
  if (!s || !terms?.length) return [{ text: s, hit: false }];
  const re = new RegExp(`(?:^|\\b)(${terms.map(_escape).join('|')})`, 'gi');
  const out = [];
  let at = 0;
  for (const m of s.matchAll(re)) {
    const start = m.index + m[0].length - m[1].length;
    if (start > at) out.push({ text: s.slice(at, start), hit: false });
    out.push({ text: s.slice(start, start + m[1].length), hit: true });
    at = start + m[1].length;
  }
  if (at < s.length) out.push({ text: s.slice(at), hit: false });
  return out.length ? out : [{ text: s, hit: false }];
}

/** A short piece of `text` around the first match, for "matched in a voice note". */
export function matchSnippet(text, terms, around = 70) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s || !terms?.length) return '';
  const lower = s.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i > -1 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return '';
  const from = Math.max(0, at - Math.floor(around / 3));
  const to = Math.min(s.length, from + around);
  return `${from > 0 ? '…' : ''}${s.slice(from, to).trim()}${to < s.length ? '…' : ''}`;
}

/** True when the note's own text has none of the terms (so a match came from an attachment). */
export function textHasTerms(note, terms) {
  if (!terms?.length) return true;
  const hay = `${note?.title || ''} ${note?.body_md || ''} ${(note?.items || []).map(i => i.text).join(' ')}`.toLowerCase();
  return terms.some(t => new RegExp(`(?:^|\\b)${_escape(t)}`, 'i').test(hay));
}
