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

