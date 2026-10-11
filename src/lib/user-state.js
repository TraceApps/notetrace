/**
 * user-state.js: what the app keeps in memory for the account signed in.
 *
 * Module stores outlive a sign-out, so the next account would see, and
 * could change or save, the last one's:
 *   - every setting store (stores/settings.js): kept per account in
 *     storage, but each store holds the value it read last; a change still
 *     waiting to be sent is dropped;
 *   - the labels the sidebar and pickers show (stores/notes.js);
 *   - the CookTrace link and shopping list (lib/cooktrace.js).
 * Cleared when the account changes and on sign-out, before anything is
 * shown. Pages keep the rest in their own state, which goes with them when
 * the sign-in screen (or the account check) replaces the app. Server-wide
 * state (user management on, feature flags, update checks) stays.
 */
export async function resetUserState() {
  await Promise.allSettled([
    import('../stores/settings.js').then(m => m.reloadSettingStores?.({ force: true })),
    import('../stores/notes.js').then(m => { m.clearLabels?.(); m.signalNotesChanged?.(); }),
    import('./cooktrace.js').then(m => m.resetCooktraceState?.()),
  ]);
}
