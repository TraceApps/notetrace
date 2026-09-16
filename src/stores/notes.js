/**
 * notes.js: shared note UI state.
 *
 * - labels: the user's labels, used by the sidebar, cards, filters, and
 *   pickers. Loaded once and refreshed after any label change or sync.
 * - notesChanged: a counter screens watch to reload their list after a
 *   background sync or an edit made somewhere else in the app.
 * - countsChanged: the same idea for the sidebar badges alone, for changes
 *   that shouldn't make a whole screen reload (ticking off a task).
 */
import { writable, derived } from 'svelte/store';
import { NoteApi } from '../lib/api.js';

export const labels = writable([]);
export const labelsById = derived(labels, $l => new Map($l.map(l => [l.id, l])));
export const notesChanged = writable(0);
export const countsChanged = writable(0);

let _loading = null;

export function refreshLabels() {
  if (_loading) return _loading;
  _loading = NoteApi.getLabels()
    .then(rows => { labels.set(Array.isArray(rows) ? rows : []); })
    .catch(() => {})
    .finally(() => { _loading = null; });
  return _loading;
}

export function signalNotesChanged() {
  notesChanged.update(n => n + 1);
}

/** A due date or a tick changed: badges recount, screens stay as they are. */
export function signalCountsChanged() {
  countsChanged.update(n => n + 1);
}

if (typeof window !== 'undefined') {
  window.addEventListener('note:sync-complete', (e) => {
    const r = e.detail || {};
    if (r.ok === false) return;
    if ((r.pulled || 0) > 0 || (r.pushed || 0) > 0) {
      refreshLabels();
      signalNotesChanged();
    }
  });
}
