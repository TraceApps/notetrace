/**
 * back-stack.js: what Android's back button (or gesture) closes first. A
 * full-screen layer, like the drawing editor or a file viewer, registers a
 * handler while it's open; back runs the most recent one instead of leaving
 * the page underneath, which would throw the layer away unsaved.
 *
 *   const release = onBack(() => close());
 *   ...
 *   release();
 */
const stack = [];

export function onBack(handler) {
  const entry = { handler };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Run the topmost handler. True when something took the back press. */
export function handleBack() {
  const entry = stack.pop();
  if (!entry) return false;
  try { entry.handler(); } catch { /* the layer is gone either way */ }
  return true;
}
