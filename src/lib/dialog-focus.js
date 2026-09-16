/**
 * dialog-focus.js: keyboard and screen reader behaviour for anything that
 * opens over the page (dialogs, sheets, viewers).
 *
 *   <div role="dialog" use:dialogFocus={{ onEscape: close }}>
 *
 * - Focus moves in when it opens: to an element marked data-autofocus, else
 *   the first control, else the container itself (give it tabindex="-1").
 * - Tab and Shift+Tab wrap around inside it instead of wandering to the page
 *   behind. Focus that has moved into something opened on top (a menu
 *   portalled to <body>) is left alone.
 * - Escape calls onEscape and stops there, so whatever is underneath doesn't
 *   close too.
 * - Focus goes back to where it was when it closes.
 *
 * Options: onEscape, autofocus (false: the component places focus itself),
 * restore (false: leave focus alone on close), disabled (an inline pane, say).
 */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]', 'audio[controls]', 'video[controls]',
].join(',');

const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';

export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(visible);
}

export function dialogFocus(node, options = {}) {
  let opts = options || {};
  const before = document.activeElement;

  function focusFirst() {
    if (opts.disabled || opts.autofocus === false) return;
    if (node.contains(document.activeElement)) return;
    const target = node.querySelector('[data-autofocus]') || focusables(node)[0] || node;
    target.focus?.({ preventScroll: true });
  }

  function onKey(e) {
    if (opts.disabled) return;
    if (e.key === 'Escape' && opts.onEscape) {
      e.preventDefault();
      e.stopPropagation();
      opts.onEscape(e);
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables(node);
    if (!list.length) { e.preventDefault(); node.focus?.(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === node)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  node.addEventListener('keydown', onKey);
  // After the opening transition has placed it.
  const timer = setTimeout(focusFirst, 30);

  return {
    update(next) { opts = next || {}; },
    destroy() {
      clearTimeout(timer);
      node.removeEventListener('keydown', onKey);
      // Only when focus was inside (or nowhere): don't pull it back from something the user moved to.
      const active = document.activeElement;
      if (!opts.disabled && opts.restore !== false && before && document.contains(before) && (!active || active === document.body || node.contains(active))) {
        before.focus?.({ preventScroll: true });
      }
    },
  };
}
