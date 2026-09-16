/**
 * note-preview.js: plain-text previews for note cards.
 *
 * Cards show readable text, not rendered Markdown, so a long note stays
 * calm in the grid. Syntax is stripped; line breaks between blocks are
 * kept so paragraphs and list lines still read as separate lines.
 */

const MAX_CHARS = 700;

export function markdownToPreview(md, maxChars = MAX_CHARS) {
  if (!md) return '';
  let text = String(md)
    .replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, ''))
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+\[([ xX])\]\s+/gm, (_, c) => (c === ' ' ? '\u2610 ' : '\u2611 '))
    .replace(/==([^=\n]+)==/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*(\d+)[.)]\s+/gm, '$1. ')
    .replace(/\[\[([^[\]\n]+)\]\]/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*([-*_]\s*){3,}$/gm, '')
    .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  if (text.length > maxChars) text = text.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
  return text;
}

/** True when a note has nothing worth keeping (used to discard empty drafts). */
export function isEmptyNote(note) {
  if (!note) return true;
  const hasItems = Array.isArray(note.items) && note.items.some(i => String(i.text || '').trim());
  const hasImages = Array.isArray(note.attachments) && note.attachments.length > 0;
  return !String(note.title || '').trim() && !String(note.body_md || '').trim() && !hasItems && !hasImages;
}

/**
 * Title and body for a reminder notification. An untitled note uses its
 * first line as the title. `fallback` is shown when the note is empty.
 */
export function reminderNotificationText(note, fallback = 'Reminder') {
  const body = note.kind === 'checklist'
    ? (note.items || []).filter(i => !i.checked).slice(0, 4).map(i => `\u2022 ${i.text}`).join('\n')
    : markdownToPreview(note.body_md, 200);
  if (note.title) return { title: note.title, body };
  if (!body) return { title: fallback, body: '' };
  const lines = body.split('\n');
  return { title: lines[0].slice(0, 80), body: lines.slice(1).join('\n') };
}
