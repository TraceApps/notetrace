/**
 * Svelte action: close a layer when its backdrop is clicked on purpose.
 *
 * A browser sends a drag's click to the closest element holding both ends,
 * so selecting text in a note and letting go outside the panel "clicked" the
 * backdrop and closed the note. Only a primary press and release that both
 * land on the backdrop itself count (from @harikiran-lab's fork,
 * TraceApps/notetrace#35).
 *
 *   <div class="backdrop" use:backdropClick={close}>
 */
export function backdropClick(node, callback) {
  let pointer = null;
  let releasedOnBackdrop = false;

  function down(e) {
    pointer = e.target === node && e.button === 0 && e.isPrimary !== false ? e.pointerId : null;
    releasedOnBackdrop = false;
  }
  function up(e) {
    releasedOnBackdrop = pointer !== null && e.pointerId === pointer && e.target === node;
  }
  function reset() { pointer = null; releasedOnBackdrop = false; }
  function click(e) {
    const dismiss = releasedOnBackdrop && e.target === node;
    reset();
    if (dismiss) callback(e);
  }

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', reset);
  node.addEventListener('click', click);
  return {
    update(next) { callback = next; },
    destroy() {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', reset);
      node.removeEventListener('click', click);
    },
  };
}
