/**
 * card-drag.js: Svelte action to drag note cards into a new order.
 *
 * Mouse: press on a card and move a few pixels. Touch: long-press a card
 * (which also selects it) and then move the finger without lifting. A copy
 * of the card follows the pointer, the card under it shows where the drop
 * lands, and on release `onDrop(dragId, targetId, after)` is called.
 * Buttons, links, and checkboxes inside a card never start a drag.
 *
 * Options: { enabled: boolean, onDrop(dragId, targetId, after) }
 */
const MOUSE_SLOP = 6;
const TOUCH_HOLD_MS = 520;
const TOUCH_SLOP = 8;

export function cardDrag(grid, options) {
  let opts = options || {};
  let press = null;   // { card, id, x, y, t, touch }
  let drag = null;    // { card, id, ghost, dx, dy, target, after }

  const cardFrom = (el) => el?.closest?.('.note-card[data-note-id]');
  const interactive = (el) => !!el?.closest?.('button, a, input, textarea, [contenteditable="true"]');

  function begin(x, y) {
    const card = press.card;
    const rect = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    Object.assign(ghost.style, {
      position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`,
      margin: '0', pointerEvents: 'none', zIndex: '400',
    });
    document.body.appendChild(ghost);
    card.classList.add('dragging');
    document.documentElement.classList.add('card-dragging');
    drag = { card, id: press.id, ghost, dx: x - rect.left, dy: y - rect.top, target: null, after: false };
    move(x, y);
  }

  function move(x, y) {
    if (!drag) return;
    drag.ghost.style.transform = `translate(${x - drag.dx - parseFloat(drag.ghost.style.left)}px, ${y - drag.dy - parseFloat(drag.ghost.style.top)}px) rotate(1.5deg) scale(1.03)`;
    const under = cardFrom(document.elementFromPoint(x, y));
    let target = under && under !== drag.card && grid.contains(under) ? under : null;
    let after = false;
    if (target) {
      const r = target.getBoundingClientRect();
      after = y > r.top + r.height / 2;
    }
    if (drag.target && (drag.target !== target || drag.after !== after)) drag.target.classList.remove('drop-before', 'drop-after');
    if (target) target.classList.add(after ? 'drop-after' : 'drop-before');
    drag.target = target;
    drag.after = after;
    // Scroll the page near the top or bottom edge.
    const edge = 70;
    if (y < edge) window.scrollBy(0, -12);
    else if (y > window.innerHeight - edge) window.scrollBy(0, 12);
  }

  function end(commit) {
    if (drag) {
      const { card, id, ghost, target, after } = drag;
      target?.classList.remove('drop-before', 'drop-after');
      card.classList.remove('dragging');
      ghost.remove();
      document.documentElement.classList.remove('card-dragging');
      drag = null;
      // Swallow the click that follows the release.
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 50);
      if (commit && target) opts.onDrop?.(Number(id), Number(target.dataset.noteId), after);
    }
    press = null;
    detach();
  }
  function swallow(e) { e.preventDefault(); e.stopPropagation(); }

  // ── Mouse ────────────────────────────────────────────────────────
  function onPointerDown(e) {
    if (!opts.enabled || e.pointerType !== 'mouse' || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const card = cardFrom(e.target);
    if (!card || interactive(e.target)) return;
    press = { card, id: card.dataset.noteId, x: e.clientX, y: e.clientY, touch: false };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }
  function onPointerMove(e) {
    if (!press || press.touch) return;
    if (!drag) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < MOUSE_SLOP) return;
      begin(e.clientX, e.clientY);
    }
    e.preventDefault();
    move(e.clientX, e.clientY);
  }
  function onPointerUp() { end(true); }

  // ── Touch ────────────────────────────────────────────────────────
  function onTouchStart(e) {
    if (!opts.enabled || e.touches.length !== 1) return;
    const card = cardFrom(e.target);
    if (!card || interactive(e.target)) return;
    const t = e.touches[0];
    press = { card, id: card.dataset.noteId, x: t.clientX, y: t.clientY, t: Date.now(), touch: true };
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchCancel);
  }
  function onTouchMove(e) {
    if (!press?.touch) return;
    const t = e.touches[0];
    if (!drag) {
      const moved = Math.hypot(t.clientX - press.x, t.clientY - press.y);
      if (moved < TOUCH_SLOP) return;
      if (Date.now() - press.t < TOUCH_HOLD_MS) { end(false); return; } // a scroll, not a drag
      begin(t.clientX, t.clientY);
    }
    e.preventDefault();
    move(t.clientX, t.clientY);
  }
  function onTouchEnd() { end(true); }
  function onTouchCancel() { end(false); }

  function detach() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', onTouchCancel);
  }
  function onKey(e) { if (drag && e.key === 'Escape') { e.preventDefault(); end(false); } }

  grid.addEventListener('pointerdown', onPointerDown);
  grid.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('keydown', onKey, true);
  return {
    update(next) { opts = next || {}; },
    destroy() {
      end(false);
      grid.removeEventListener('pointerdown', onPointerDown);
      grid.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('keydown', onKey, true);
    },
  };
}
