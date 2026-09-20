/**
 * back-stack.js: what Android's back button (or gesture) closes first. A
 * layer that's open, like the drawing editor, a file viewer, a sheet or a
 * dialog, registers a handler; back runs the most recent one instead of
 * leaving the page underneath, which would throw the layer away unsaved or
 * leave it showing over the next page. With nothing registered, back goes
 * back a page and then offers to exit, as before.
 *
 *   const release = onBack(() => close());
 *   ...
 *   release();
 *
 * In markup, attach it to the element that exists only while the layer is
 * open, and pass the same close action as the layer's own close button:
 *
 *   <div class="sheet-backdrop" use:closeOnBack={close}>
 *
 * A layer that must be answered (the sync merge questions) passes a no-op, so
 * back neither dismisses it nor navigates away underneath it.
 */
const stack = [];

/** Register `handler` for the next back press. Returns a release function. */
export function onBack(handler) {
  const entry = { handler };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/**
 * Run the topmost handler. True when something took the back press.
 *
 * The entry stays registered until its layer releases it (on destroy), so a
 * layer that doesn't close right away (the drawing editor while it saves, or
 * a question that must be answered) keeps catching back instead of letting
 * the next press navigate away underneath it.
 */
export function handleBack() {
  const entry = stack[stack.length - 1];
  if (!entry) return false;
  try { entry.handler(); } catch { /* the layer is gone either way */ }
  return true;
}

/** How many layers are waiting on back (for tests and diagnostics). */
export function backStackDepth() {
  return stack.length;
}

/**
 * Svelte action: register while the element is mounted, release when it's
 * removed (closed any other way, or the page changes).
 */
export function closeOnBack(node, handler) {
  let current = handler;
  const release = onBack(() => { if (typeof current === 'function') current(); });
  return {
    update(next) { current = next; },
    destroy: release,
  };
}
