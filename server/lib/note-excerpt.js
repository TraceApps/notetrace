/**
 * note-excerpt.js: a note's text without its Markdown marks, for somewhere too
 * small to render it (the watch, through /api/notes?slim=1).
 *
 * The app has its own copy for note cards (src/lib/note-preview.js). The server
 * image doesn't ship src/, and this one only needs the stripping, not the
 * card's line-break rules. Pure, so it's testable without a database.
 */
export function plainExcerpt(md, maxChars = 1200) {
  if (!md) return '';
  let text = String(md)
    .replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, ''))
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+\[([ xX])\]\s+/gm, (_, c) => (c === ' ' ? '\u2610 ' : '\u2611 '))
    .replace(/==([^=\n]+)==/g, '$1')
    .replace(/\+\+([^+\n]+)\+\+/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '\u2022 ')
    .replace(/\[\[([^[\]\n]+)\]\]/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  if (text.length > maxChars) text = text.slice(0, maxChars).replace(/\s+\S*$/, '') + '\u2026';
  return text;
}

