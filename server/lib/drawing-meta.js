/**
 * drawing-meta.js: the strokes behind a drawing, as stored on its attachment.
 * Pure; shared by the server, the Android app's local database, and the
 * drawing editor, so every copy of a drawing is checked the same way.
 *
 * A drawing is a picture attachment (the PNG every screen shows) plus this
 * document, which keeps it editable:
 *
 *   {
 *     v: 1,
 *     w: 1600, h: 1200,                          board size in board units
 *     bg: 'paper' | 'dark',                      the sheet
 *     grid: 'none' | 'dots' | 'squares' | 'lines',
 *     strokes: [{
 *       t: 'pen' | 'marker' | 'highlighter',
 *       c: '#rrggbb',
 *       s: 1 | 2 | 3,                            size step
 *       p: [x2, y2, pressure, ...]               x and y in half units, pressure 0 to 100
 *     }]
 *   }
 */
export const DRAWING_VERSION = 1;
export const DRAWING_TOOLS = ['pen', 'marker', 'highlighter'];
export const DRAWING_BACKGROUNDS = ['paper', 'dark'];
export const DRAWING_GRIDS = ['none', 'dots', 'squares', 'lines'];
export const BOARD_WIDTH = 1600;
export const MAX_BOARD_HEIGHT = 40000;
export const MAX_STROKES = 5000;
export const MAX_POINTS = 300000;
export const MAX_DRAWING_CHARS = 4 * 1024 * 1024;

const _num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : null;
};

/** A drawing (object or JSON text) as a clean document, or null when it isn't one. */
export function parseDrawing(v) {
  let d = v;
  if (typeof v === 'string') {
    if (!v || v.length > MAX_DRAWING_CHARS) return null;
    try { d = JSON.parse(v); } catch { return null; }
  }
  if (!d || typeof d !== 'object' || d.v !== DRAWING_VERSION || !Array.isArray(d.strokes)) return null;
  const w = _num(d.w, 200, 8000) ?? BOARD_WIDTH;
  const h = _num(d.h, 200, MAX_BOARD_HEIGHT) ?? Math.round(w * 0.75);
  const strokes = [];
  let points = 0;
  for (const s of d.strokes.slice(0, MAX_STROKES)) {
    if (!s || !DRAWING_TOOLS.includes(s.t) || !Array.isArray(s.p)) continue;
    const c = /^#[0-9a-f]{6}$/i.test(String(s.c || '')) ? String(s.c).toLowerCase() : '#1f1f1f';
    const size = _num(s.s, 1, 3) ?? 2;
    const n = Math.floor(s.p.length / 3) * 3;
    if (n < 3 || points + n / 3 > MAX_POINTS) continue;
    const p = new Array(n);
    let ok = true;
    for (let i = 0; i < n; i += 3) {
      const x = _num(s.p[i], -1000, w * 2 + 1000), y = _num(s.p[i + 1], -1000, h * 2 + 1000), pr = _num(s.p[i + 2], 0, 100);
      if (x == null || y == null || pr == null) { ok = false; break; }
      p[i] = x; p[i + 1] = y; p[i + 2] = pr;
    }
    if (!ok) continue;
    points += n / 3;
    strokes.push({ t: s.t, c, s: size, p });
  }
  return {
    v: DRAWING_VERSION,
    w,
    h,
    bg: DRAWING_BACKGROUNDS.includes(d.bg) ? d.bg : 'paper',
    grid: DRAWING_GRIDS.includes(d.grid) ? d.grid : 'none',
    strokes,
  };
}

/** For storage: JSON text, or null when it isn't a drawing (or is too big). */
export function drawingText(v) {
  const d = parseDrawing(v);
  if (!d) return null;
  const text = JSON.stringify(d);
  return text.length <= MAX_DRAWING_CHARS ? text : null;
}

/** An empty board. */
export const emptyDrawing = (bg = 'paper', grid = 'none') => ({ v: DRAWING_VERSION, w: BOARD_WIDTH, h: 1200, bg, grid, strokes: [] });

// ── Geometry (board units) ──────────────────────────────────────────────

/** A stroke's points as [[x, y, pressure 0..1], ...]. */
export function strokePoints(stroke) {
  const out = [];
  for (let i = 0; i + 2 < stroke.p.length; i += 3) out.push([stroke.p[i] / 2, stroke.p[i + 1] / 2, stroke.p[i + 2] / 100]);
  return out;
}

/** { x, y, w, h } around a stroke, or around several. Null when there's nothing. */
export function strokesBounds(strokes, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i + 2 < s.p.length; i += 3) {
      const x = s.p[i] / 2, y = s.p[i + 1] / 2;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

const _segDist2 = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return x * x + y * y;
};

/** Does a stroke pass within `radius` of (x, y)? What the eraser asks. */
export function strokeHit(stroke, x, y, radius) {
  const r2 = radius * radius;
  const pts = stroke.p;
  if (pts.length < 6) return pts.length >= 3 && (pts[0] / 2 - x) ** 2 + (pts[1] / 2 - y) ** 2 <= r2;
  for (let i = 0; i + 5 < pts.length; i += 3) {
    if (_segDist2(x, y, pts[i] / 2, pts[i + 1] / 2, pts[i + 3] / 2, pts[i + 4] / 2) <= r2) return true;
  }
  return false;
}

/** Is (x, y) inside a polygon of [[x, y], ...]? */
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/** Indexes of the strokes a lasso holds: most of their points are inside it. */
export function strokesInLasso(strokes, poly, share = 0.6) {
  if (!poly || poly.length < 3) return [];
  const out = [];
  strokes.forEach((s, idx) => {
    let inside = 0, total = 0;
    for (let i = 0; i + 2 < s.p.length; i += 3) {
      total++;
      if (pointInPolygon(s.p[i] / 2, s.p[i + 1] / 2, poly)) inside++;
    }
    if (total && inside / total >= share) out.push(idx);
  });
  return out;
}

/** A copy of a stroke moved by (dx, dy) board units. */
export function moveStroke(stroke, dx, dy) {
  const p = stroke.p.slice();
  for (let i = 0; i + 2 < p.length; i += 3) { p[i] = Math.round(p[i] + dx * 2); p[i + 1] = Math.round(p[i + 1] + dy * 2); }
  return { ...stroke, p };
}
