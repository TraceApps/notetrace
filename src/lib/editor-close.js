/**
 * editor-close.js: what closing a note does, however the note goes.
 *
 * Closing the editor (Done, Escape, back) saves what's still waiting, has
 * the [[links]] follow a rename, removes a note left empty, and tells the
 * lists and the sidebar. A note can also go without being closed: another
 * note picked in the List layout's pane, a reminder link opening a note
 * there, the pane closing for the grid, or the page left with the note
 * open. Each of those runs the same steps through here, once:
 *
 *   - finish(): the steps, without the editor's close event. A second call
 *     (Done pressed while a switch is closing it) gets the same run.
 *   - pass(): finish() for a note left without Done. One left empty goes
 *     only if it was changed here (emptied, or new): an empty note only
 *     looked at, arrowing down the list, stays.
 *   - leave(): pass() for a switch; the close event that a close running
 *     meanwhile would send is left out, since the next note takes the place.
 *   - handOff(): the note moves to another editor still open (a foldable
 *     folding or unfolding), so nothing is closed here.
 *   - gone(sameAccount): the editor goes away. Not closed, the steps run on
 *     the way out; closed, what was typed while that was under way still
 *     saves. Nothing, when the account changed meanwhile or it was handed off.
 *
 * steps: { flush(), renameLinks() -> true when links were renamed,
 *          dropIfEmpty(skipDiscard, untouchedStays), announce(skipDiscard),
 *          noteId() }
 *
 * finish() and leave() resolve to { id, renamed }: the note's id (null when
 * it was removed as empty) and whether its rename changed other notes' links,
 * so a note opened next isn't shown as the list had it before.
 */
export function editorCloser(steps) {
  let finishing = null;
  let leaving = false;
  let handedOff = false;

  async function run(skipDiscard, untouchedStays) {
    await steps.flush();
    const renamed = !!(await steps.renameLinks());
    // Typing that came in while the links went out is saved as well.
    await steps.flush();
    await steps.dropIfEmpty(skipDiscard, untouchedStays);
    steps.announce(skipDiscard);
    return { id: steps.noteId?.() ?? null, renamed };
  }

  function finish(skipDiscard = false, { untouchedStays = false } = {}) {
    if (!finishing) finishing = run(skipDiscard, untouchedStays);
    return finishing;
  }
  // Every way but Done: an empty note only looked at (arrow keys down the
  // list, say) stays; one emptied here goes, as Done would remove it.
  const passing = () => finish(false, { untouchedStays: true });

  return {
    finish,
    /** finish() for a note left without Done. */
    pass: passing,
    leave() {
      leaving = true;
      return passing();
    },
    /** A close that ended while a switch was under way sends no close event. */
    get leaving() { return leaving; },
    handOff() { handedOff = true; },
    gone(sameAccount) {
      if (handedOff || !sameAccount) return null;
      // Closed already: only what was typed while that was under way.
      if (finishing) return Promise.resolve(steps.flush()).catch(() => null);
      return passing().catch(() => null);
    },
  };
}
