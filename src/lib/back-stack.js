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
export function onBack(handler, node = null) {
  const entry = { handler, node };
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
 * Whether `node`'s layer is the newest one open. Escape closes only that one,
 * as back does: a calendar opened from a reminder closes, the reminder stays.
 */
export function isTopLayer(node) {
  const top = stack[stack.length - 1];
  return !!top && !!node && top.node === node;
}

/**
 * Escape for a layer that listens on the whole window (a popover). While it's
 * the newest, it closes. While a layer opened from it is newer, that one
 * closes instead, even before it has taken focus (inside it, its own Escape
 * handles it, so this leaves it alone). A newer layer with no element of its
 * own (a viewer) listens for itself. True when Escape was used here.
 */
export function escapeFrom(node, close, target) {
  const top = stack[stack.length - 1];
  if (!top || !node || !stack.some(e => e.node === node)) return false;
  if (top.node === node) { close(); return true; }
  if (!top.node || top.node.contains?.(target)) return false;
  top.handler();
  return true;
}

const zOf = (el) => {
  if (!el || typeof getComputedStyle !== 'function') return 0;
  const z = parseInt(getComputedStyle(el).zIndex, 10);
  return Number.isFinite(z) ? z : 0;
};

/**
 * Svelte action: register while the element is mounted, release when it's
 * removed (closed any other way, or the page changes).
 *
 * A layer opened from another one shows above it, whatever its own z-index
 * says: a calendar sheet (200) opened from a reminder popover (300) used to
 * open underneath it, where the popover's backdrop took its clicks
 * (TraceApps/notetrace#39).
 */
export function closeOnBack(node, handler) {
  let current = handler;
  const below = [...stack].reverse().find(e => e.node)?.node;
  const inline = node?.style?.zIndex ?? '';
  const under = zOf(below);
  if (below && node?.style && zOf(node) <= under) node.style.zIndex = String(under + 1);
  const release = onBack(() => { if (typeof current === 'function') current(); }, node);
  return {
    update(next) { current = next; },
    destroy() {
      release();
      if (node?.style) node.style.zIndex = inline;
    },
  };
}
