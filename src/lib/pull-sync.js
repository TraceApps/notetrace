/**
 * pull-sync.js: which touches may start the Android pull-to-refresh.
 *
 * Pull-to-refresh listens to every touch on the page (so it also works over
 * the fixed top bar). Anything that uses a downward drag for its own purpose
 * must be left out, or dragging it down while the page is at the top reads
 * as a pull and syncs. Same fix as NutriTrace #225.
 *
 *   dialogs, sheets, sidebar, bottom bar, the note editor, the bulk bar,
 *   popovers, and the floating buttons and their menu: their own handling
 *   [data-no-pull-sync]   anything draggable: reorder handles (Tasks,
 *                         checklists, labels), the voice note scrubber, the
 *                         list width resizer
 */
export const PULL_SYNC_EXEMPT = [
  '[role="dialog"]', '.sheet-backdrop', '.sidebar-panel', '.sidebar-backdrop', '.bottom-nav',
  '.editor-backdrop', '.bulk-bar', '.pop-backdrop', '.fab', '.fab-menu', '.fab-scrim',
  '[data-no-pull-sync]',
].join(', ');

/** True when a touch on `target` must not start a pull-to-refresh. */
export function isPullSyncExempt(target) {
  return !!(target && typeof target.closest === 'function' && target.closest(PULL_SYNC_EXEMPT));
}
