/**
 * row-swipe.js: Svelte action to swipe a list row sideways on a touch screen,
 * as task apps do: right to complete, left to delete. The row's `.swipe-body`
 * child follows the finger over whatever sits behind it; past the threshold
 * the row is "armed" (data-swipe="right" | "left", for styling the backdrop)
 * and letting go runs `onSwipe(dir)`. Short of it, it springs back.
 *
 * Vertical movement scrolls as usual, and a long press (drag to reorder)
 * never turns into a swipe.
 *
 * Options: { enabled: boolean, onSwipe(dir), left: boolean, right: boolean }
 */
const START_SLOP = 12;
const THRESHOLD = 0.32;   // of the row width

export function rowSwipe(row, options) {
  let opts = options || {};
  let s = null; // { x, y, t, dx, active }

  const body = () => row.querySelector('.swipe-body');
  const interactive = (el) => !!el?.closest?.('input, textarea, [data-no-swipe]');

  function onStart(e) {
    if (!opts.enabled || e.touches.length !== 1 || interactive(e.target)) return;
    if (document.documentElement.classList.contains('dnd-dragging')) return;
    const t = e.touches[0];
    s = { x: t.clientX, y: t.clientY, t: Date.now(), dx: 0, active: false };
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onCancel);
  }

  function allowed(dx) {
    return dx > 0 ? opts.right !== false : opts.left !== false;
  }

  function onMove(e) {
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (!s.active) {
      if (Math.abs(dx) < START_SLOP && Math.abs(dy) < START_SLOP) return;
      if (Math.abs(dy) >= Math.abs(dx) || Date.now() - s.t > 450 || !allowed(dx)) { stop(); return; }
      s.active = true;
      row.classList.add('swiping');
    }
    e.preventDefault();
    s.dx = allowed(dx) ? dx : 0;
    const el = body();
    if (el) el.style.transform = `translateX(${s.dx}px)`;
    const w = row.offsetWidth || 1;
    row.dataset.swipe = Math.abs(s.dx) > w * THRESHOLD ? (s.dx > 0 ? 'right' : 'left') : (s.dx > 0 ? 'right-peek' : s.dx < 0 ? 'left-peek' : '');
  }

  function onEnd() {
    if (!s) return;
    const { dx, active } = s;
    const w = row.offsetWidth || 1;
    const el = body();
    if (active && Math.abs(dx) > w * THRESHOLD) {
      if (el) {
        el.style.transition = 'transform 180ms ease';
        el.style.transform = `translateX(${Math.sign(dx) * w}px)`;
      }
      // The click that follows a swipe mustn't start editing the row.
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => {
        window.removeEventListener('click', swallow, { capture: true });
        opts.onSwipe?.(dx > 0 ? 'right' : 'left');
        reset();
      }, 180);
    } else {
      reset(true);
    }
    stop();
  }

  function onCancel() { reset(true); stop(); }

  function swallow(e) { e.stopPropagation(); e.preventDefault(); }

  function reset(animate = false) {
    const el = body();
    row.classList.remove('swiping');
    delete row.dataset.swipe;
    if (!el) return;
    if (animate) {
      el.style.transition = 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)';
      el.style.transform = 'translateX(0)';
      setTimeout(() => { el.style.transition = ''; el.style.transform = ''; }, 240);
    } else {
      el.style.transition = '';
      el.style.transform = '';
    }
  }

  function stop() {
    s = null;
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onEnd);
    window.removeEventListener('touchcancel', onCancel);
  }

  row.addEventListener('touchstart', onStart, { passive: true });
  return {
    update(next) { opts = next || {}; },
    destroy() { stop(); row.removeEventListener('touchstart', onStart); },
  };
}
