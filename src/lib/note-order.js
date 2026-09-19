/**
 * note-order.js: custom note order. Pure, so it's testable.
 *
 * The order is a list of note keys saved as a user setting, so it follows
 * the user to every device. A key is the server's note id (`s12`), or the
 * device's own id (`l7`) for a note that has never reached a server. Notes
 * missing from the list (new ones) come first, newest edit first, the way
 * a new note lands at the top.
 */
export function noteKey(note, { native = false } = {}) {
  if (note?.server_id != null) return `s${note.server_id}`;
  return native ? `l${note.id}` : `s${note.id}`;
}

/** Sort notes by the saved order; notes not in it keep their order, first. */
export function applyOrder(notes, order, keyOf) {
  if (!Array.isArray(order) || !order.length) return notes;
  const pos = new Map(order.map((k, i) => [k, i]));
  const fresh = [], placed = [];
  for (const n of notes) (pos.has(keyOf(n)) ? placed : fresh).push(n);
  placed.sort((a, b) => pos.get(keyOf(a)) - pos.get(keyOf(b)));
  return [...fresh, ...placed];
}

/** Move one id before or after another within a list of ids. */
export function moveId(ids, dragId, targetId, after) {
  if (dragId === targetId) return ids;
  const rest = ids.filter(id => id !== dragId);
  const at = rest.indexOf(targetId);
  if (at < 0) return ids;
  rest.splice(after ? at + 1 : at, 0, dragId);
  return rest;
}

/**
 * Save a section's new order into the whole list: the section's keys go
 * first in their new order, then every other key keeps its place. Sections
 * (pinned, others, a label) are shown separately, so their relative order
 * doesn't matter.
 */
export function mergeOrder(order, sectionKeys) {
  const inSection = new Set(sectionKeys);
  return [...sectionKeys, ...(order || []).filter(k => !inSection.has(k))];
}
