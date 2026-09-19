/**
 * card-swipe.js: Svelte action to swipe a note card sideways on a touch
 * screen. Past the threshold the card slides away and `onSwipe(id, dir)`
 * runs; short of it, the card springs back. Vertical movement scrolls as
 * usual, and a long press (select, drag) never turns into a swipe.
 *
 * Options: { enabled: boolean, onSwipe(id, dir) }
 */
const START_SLOP = 12;
const THRESHOLD = 0.38;   // of the card width

export function cardSwipe(grid, options) {
  let opts = options || {};
  let s = null; // { card, id, x, y, t, dx, active }

  const cardFrom = (el) => el?.closest?.('.note-card[data-note-id]');
  const interactive = (el) => !!el?.closest?.('button, a, input, textarea');

  function onStart(e) {
    if (!opts.enabled || e.touches.length !== 1) return;
    const card = cardFrom(e.target);
    if (!card || interactive(e.target) || document.documentElement.classList.contains('card-dragging')) return;
    const t = e.touches[0];
    s = { card, id: Number(card.dataset.noteId), x: t.clientX, y: t.clientY, t: Date.now(), dx: 0, active: false };
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onCancel);
  }
  function onMove(e) {
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (!s.active) {
      if (Math.abs(dx) < START_SLOP && Math.abs(dy) < START_SLOP) return;
      // Vertical first, or after a long press: not a swipe.
      if (Math.abs(dy) >= Math.abs(dx) || Date.now() - s.t > 450 || document.documentElement.classList.contains('card-dragging')) { stop(); return; }
      s.active = true;
      s.card.classList.add('swiping');
    }
    e.preventDefault();
    s.dx = dx;
    const w = s.card.offsetWidth || 1;
    s.card.style.transform = `translateX(${dx}px) rotate(${dx / w * 4}deg)`;
    s.card.style.opacity = String(Math.max(0.25, 1 - Math.abs(dx) / w));
    s.card.classList.toggle('swipe-armed', Math.abs(dx) > w * THRESHOLD);
  }
  function onEnd() {
    if (!s) return;
    const { card, id, dx, active } = s;
    const w = card.offsetWidth || 1;
    if (active && Math.abs(dx) > w * THRESHOLD) {
      card.style.transition = 'transform 200ms ease, opacity 200ms ease';
      card.style.transform = `translateX(${Math.sign(dx) * w * 1.3}px) rotate(${Math.sign(dx) * 8}deg)`;
      card.style.opacity = '0';
      // The click that follows a swipe must not open the note.
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => {
        window.removeEventListener('click', swallow, { capture: true });
        opts.onSwipe?.(id, dx > 0 ? 'right' : 'left');
        reset(card);
      }, 190);
    } else if (active) {
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 50);
      reset(card, true);
    }
    stop();
  }
  function onCancel() { if (s?.active) reset(s.card, true); stop(); }
  function swallow(e) { e.preventDefault(); e.stopPropagation(); }
  function reset(card, animate = false) {
    card.classList.remove('swiping', 'swipe-armed');
    card.style.transition = animate ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 220ms ease' : '';
    card.style.transform = '';
    card.style.opacity = '';
    if (animate) setTimeout(() => { card.style.transition = ''; }, 240);
  }
  function stop() {
    s = null;
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onEnd);
    window.removeEventListener('touchcancel', onCancel);
  }

  grid.addEventListener('touchstart', onStart, { passive: true });
  return {
    update(next) { opts = next || {}; },
    destroy() { stop(); grid.removeEventListener('touchstart', onStart); },
  };
}
