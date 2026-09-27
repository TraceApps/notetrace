/**
 * highlight.js: showing where a search matched. Pure, and tested.
 *
 * Search matches word beginnings (the same rule the server's full-text index
 * uses), so "jelly" highlights "Jellyfin".
 */
import { stripAccents } from './search-text.js';

export function searchTerms(query) {
  // Accents come off, since the search itself ignores them: a query of "cafe"
  // finds "Café", so the term has to be able to mark it.
  return stripAccents(query).split(/[\s,.;:!?"'()[\]{}]+/).map(t => t.trim()).filter(t => t.length > 1).slice(0, 8);
}

const _escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A folded term still has to match the accented spelling in the text the note
// actually holds, and the match positions index into that original text, so
// each letter matches its accented forms rather than folding the text.
const _ACCENT_CLASS = {
  a: 'aáàâäãå', e: 'eéèêë', i: 'iíìîï',
  o: 'oóòôöõ', u: 'uúùûü',
  c: 'cçč', n: 'nñń', y: 'yýÿ', s: 'sšś', z: 'zžż',
};
const _termPattern = (term) => [...String(term)]
  .map(ch => (_ACCENT_CLASS[ch] ? `[${_ACCENT_CLASS[ch]}]` : _escape(ch)))
  .join('');

/** Text split into { text, hit } pieces, so a component can mark the hits. */
export function highlightParts(text, terms) {
  const s = String(text ?? '');
  if (!s || !terms?.length) return [{ text: s, hit: false }];
  // A letter-or-digit class rather than \b, which counts an accented letter
  // as a boundary and would mark the "cafe" inside "Précafé".
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${terms.map(_termPattern).join('|')})`, 'giu');
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
  // The offsets index into `s`, so only fold when folding kept the length
  // (a precomposed accent folds to one letter; a decomposed one would not).
  const folded = stripAccents(s);
  const lower = folded.length === s.length ? folded : s.toLowerCase();
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
  const hay = stripAccents(`${note?.title || ''} ${note?.body_md || ''} ${(note?.items || []).map(i => i.text).join(' ')}`);
  return terms.some(t => new RegExp(`(?:^|\\b)${_escape(t)}`, 'i').test(hay));
}
