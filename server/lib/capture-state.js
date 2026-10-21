export function captureSource(note) {
  try {
    const source = JSON.parse(note?.source_json || 'null');
    if (!source || typeof source.url !== 'string') return null;
    const url = new URL(source.url);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? source : null;
  } catch { return null; }
}

export function captureReminderActive(note) {
  if (!note || note.deleted_at || note.trashed_at) return false;
  if (!captureSource(note)?.task) return true;
  return note.kind === 'checklist' && (note.items || []).some(i => !i.checked && !i.deleted_at);
}
