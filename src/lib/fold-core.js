/** fold-core.js: size classes, and fold reports turned into { posture, start, end }. Pure, and tested. */

export const MEDIUM_MIN = 600;
export const EXPANDED_MIN = 1024;

/** compact under 600px, medium to 1023px, expanded from 1024px. */
export function sizeClassFor(width) {
  return width < MEDIUM_MIN ? 'compact' : width < EXPANDED_MIN ? 'medium' : 'expanded';
}

/** A plugin payload ({ features: [...] }) to a fold, or null. Pure. */
export function foldFromFeatures(payload) {
  const f = (payload?.features || []).find(x => x.state === 'half_opened' || x.separating);
  if (!f) return null;
  const vertical = f.orientation === 'vertical';
  const start = Math.round(vertical ? f.left : f.top);
  const end = Math.round(vertical ? f.right : f.bottom);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { posture: vertical ? 'book' : 'tabletop', start, end };
}

/** Viewport segments (DOMRect-like) to a fold, or null. Pure. */
export function foldFromSegments(segments) {
  if (!segments || segments.length !== 2) return null;
  const [a, b] = segments;
  if (b.x >= a.x + a.width - 1 && Math.abs(a.y - b.y) < 2) return { posture: 'book', start: Math.round(a.x + a.width), end: Math.round(b.x) };
  if (b.y >= a.y + a.height - 1 && Math.abs(a.x - b.x) < 2) return { posture: 'tabletop', start: Math.round(a.y + a.height), end: Math.round(b.y) };
  return null;
}

/**
 * Card columns either side of a book fold, or null when the crease does not
 * cross this box, or leaves too little room on one side to be worth it.
 *
 * A masonry grid across a half-open foldable puts cards over the crease, with
 * their text split by it. Dealing into separate column runs either side, with
 * the hinge as an empty track between them, keeps every card on one panel.
 *
 * `left` is the box's own x on screen, since the fold is reported in screen
 * coordinates and the grid may sit beside a sidebar.
 */
export function columnsAcrossFold({ width, left = 0, gap, minCard, fold }) {
  if (!fold || fold.posture !== 'book') return null;
  if (!(width > 0) || !(minCard > 0)) return null;
  const start = fold.start - left;
  const end = fold.end - left;
  // Entirely to one side of this grid: nothing to do.
  if (!(start > 0 && end < width)) return null;
  const fit = (available) => Math.floor((available + gap) / (minCard + gap));
  const l = fit(start);
  const r = fit(width - end);
  // A single column that would be squeezed to nothing is worse than a card
  // crossing the crease, so the split only happens when both sides work.
  if (l < 1 || r < 1) return null;
  return { left: l, right: r, hinge: Math.max(0, Math.round(end - start)) };
}
