/**
 * widget-snapshot.js: what the Android Notes widget shows, worked out from
 * the notes (home-widget.js sends it). Pinned notes first, then the newest
 * edits, each with a title, a few lines of text, and its colour.
 */
import { markdownToPreview } from './note-preview.js';
import { NOTE_COLORS } from './note-colors.js';
import { isAudio, isImage, isFile } from './file-kinds.js';

export const WIDGET_NOTES = 25;
const TEXT_CHARS = 180;

const _dot = (color) => NOTE_COLORS.find(c => c.value && c.value === color)?.dot || null;

/** What a note's row says under its title. */
export function widgetText(note, t = (k) => k) {
  if (note.kind === 'checklist') {
    const open = (note.items || []).filter(i => !i.checked && String(i.text || '').trim());
    const lines = [...open].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).slice(0, 4).map(i => `☐ ${String(i.text).trim()}`);
    if (lines.length) return lines.join('\n');
    if ((note.items || []).length) return t('widget.all_done');
  } else {
    const text = markdownToPreview(note.body_md, TEXT_CHARS);
    if (text) return text;
  }
  const atts = note.attachments || [];
  if (atts.some(a => a.is_drawing)) return t('widget.drawing');
  if (atts.some(isAudio)) return t('widget.voice_note');
  if (atts.some(isImage)) return t('widget.image');
  if (atts.some(isFile)) return t('widget.file');
  return '';
}

/** The snapshot for a list of notes: pinned first, then the newest edits. */
export function widgetSnapshot(notes, { locked = false, t } = {}) {
  if (locked) return { locked: true, notes: [] };
  const stamp = (n) => String(n.updated_at || '');
  const rows = [...(notes || [])]
    .filter(n => !n.archived && !n.trashed_at)
    .sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || stamp(b).localeCompare(stamp(a)))
    .slice(0, WIDGET_NOTES)
    .map(n => ({ id: n.id, title: String(n.title || '').slice(0, 200), text: widgetText(n, t), color: _dot(n.color), pinned: !!n.pinned }));
  return { locked: false, notes: rows };
}
