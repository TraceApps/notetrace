/**
 * grow-on-scroll.js: a Svelte action for "render a screenful, add more as you
 * scroll". Put it on a marker element after the last rendered item; when the
 * marker comes near the viewport, `onGrow()` is called.
 *
 *   <div use:growOnScroll={{ onGrow: () => shown += PAGE }}></div>
 */
export function growOnScroll(node, options) {
  let opts = options || {};
  if (typeof IntersectionObserver === 'undefined') {
    // Without the observer, show everything rather than cutting the list off.
    opts.onGrow?.();
    return { update(next) { opts = next || {}; opts.onGrow?.(); }, destroy() {} };
  }
  const io = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) opts.onGrow?.();
  }, { rootMargin: opts.rootMargin || '1500px 0px' });
  io.observe(node);
  return {
    update(next) { opts = next || {}; },
    destroy() { io.disconnect(); },
  };
}
