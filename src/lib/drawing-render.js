/**
 * drawing-render.js: drawing a drawing. Strokes become smooth, pressure-aware
 * shapes with perfect-freehand; the sheet is paper or dark, with an optional
 * grid; and a finished drawing becomes the PNG a note shows.
 *
 * Everything here works in board units (drawing-meta.js); a caller sets the
 * canvas transform for zoom and scroll.
 */
import { getStroke } from 'perfect-freehand';
import { strokePoints, strokesBounds } from '../../server/lib/drawing-meta.js';

/** Ink colours. The first is "ink": black on paper, near white on a dark sheet. */
export const INK = '#1f1f1f';
export const PALETTE = [INK, '#80868b', '#e53935', '#f4511e', '#f9a825', '#43a047', '#1e88e5', '#8e24aa', '#d81b60'];
export const HIGHLIGHTS = ['#fff176', '#a5d6a7', '#90caf9', '#f48fb1', '#ffcc80'];
export const SIZES = { pen: [3.5, 6, 10], marker: [10, 16, 26], highlighter: [18, 28, 42] };
export const SHEET = { paper: '#ffffff', dark: '#16171d' };
const GRID_INK = { paper: 'rgba(60, 64, 67, 0.16)', dark: 'rgba(255, 255, 255, 0.09)' };
export const GRID_STEP = 40;

export const inkFor = (color, bg) => (bg === 'dark' && color === INK ? '#eceef3' : color);

// perfect-freehand's outline to an SVG path, the smooth way its readme shows.
function _svgPath(points) {
  if (points.length < 4) return '';
  const avg = (a, b) => (a + b) / 2;
  let a = points[0], b = points[1];
  const c = points[2];
  let d = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${avg(b[0], c[0]).toFixed(2)},${avg(b[1], c[1]).toFixed(2)} T`;
  for (let i = 2; i < points.length - 1; i++) {
    a = points[i];
    b = points[i + 1];
    d += `${avg(a[0], b[0]).toFixed(2)},${avg(a[1], b[1]).toFixed(2)} `;
  }
  return `${d}Z`;
}

const _paths = new WeakMap();

/** The filled shape of a stroke, as a Path2D (kept per stroke object). */
export function strokePath(stroke, live = false) {
  if (!live && _paths.has(stroke)) return _paths.get(stroke);
  const size = SIZES[stroke.t]?.[stroke.s - 1] ?? 4;
  const pts = strokePoints(stroke);
  // Mouse and finger points all say 0.5; only a stylus reports real pressure.
  const real = pts.some(p => Math.abs(p[2] - 0.5) > 0.01);
  const opts = stroke.t === 'pen'
    // A stylus thins and swells with pressure; a mouse or finger gets a steadier line.
    ? { size, thinning: real ? 0.6 : 0.28, smoothing: 0.5, streamline: 0.4, simulatePressure: !real, last: !live }
    : stroke.t === 'marker'
      ? { size, thinning: 0.12, smoothing: 0.6, streamline: 0.45, simulatePressure: false, last: !live }
      : { size, thinning: 0, smoothing: 0.65, streamline: 0.55, simulatePressure: false, start: { cap: false }, end: { cap: false }, last: !live };
  let outline = getStroke(pts.length === 1 ? [pts[0], [pts[0][0] + 0.1, pts[0][1] + 0.1, pts[0][2]]] : pts, opts);
  const path = new Path2D(_svgPath(outline));
  if (!live) _paths.set(stroke, path);
  return path;
}

export function drawStroke(ctx, stroke, bg, live = false) {
  ctx.save();
  if (stroke.t === 'highlighter') {
    // Multiply keeps ink readable under it on paper; on a dark sheet it would vanish, so it simply sits on top.
    ctx.globalAlpha = bg === 'dark' ? 0.5 : 0.42;
    ctx.globalCompositeOperation = bg === 'dark' ? 'source-over' : 'multiply';
  }
  ctx.fillStyle = inkFor(stroke.c, bg);
  ctx.fill(strokePath(stroke, live));
  ctx.restore();
}

/** The sheet and its grid over the board rectangle (x, y, w, h). */
export function drawSheet(ctx, bg, grid, rect, scale = 1) {
  ctx.save();
  ctx.fillStyle = SHEET[bg] || SHEET.paper;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  if (grid && grid !== 'none') {
    ctx.fillStyle = ctx.strokeStyle = GRID_INK[bg] || GRID_INK.paper;
    ctx.lineWidth = 1 / scale;
    const x0 = Math.floor(rect.x / GRID_STEP) * GRID_STEP, y0 = Math.floor(rect.y / GRID_STEP) * GRID_STEP;
    const x1 = rect.x + rect.w, y1 = rect.y + rect.h;
    if (grid === 'dots') {
      const r = Math.max(1.4, 1.6 / scale);
      for (let y = y0; y <= y1; y += GRID_STEP) for (let x = x0; x <= x1; x += GRID_STEP) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      ctx.beginPath();
      for (let y = y0; y <= y1; y += GRID_STEP) { ctx.moveTo(rect.x, y); ctx.lineTo(x1, y); }
      if (grid === 'squares') for (let x = x0; x <= x1; x += GRID_STEP) { ctx.moveTo(x, rect.y); ctx.lineTo(x, y1); }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * The PNG a note shows: the part of the board with drawing on it, with a
 * margin, at most `maxWidth` pixels wide. { blob, width, height }.
 */
export async function renderDrawingPng(doc, { maxWidth = 1600, pad = 48, minW = 640, minH = 420 } = {}) {
  let b = strokesBounds(doc.strokes, pad + 24) || { x: 0, y: 0, w: minW, h: minH };
  // A small doodle still gets a sensible sheet around it.
  if (b.w < minW) { b.x -= (minW - b.w) / 2; b.w = minW; }
  if (b.h < minH) { b.y -= (minH - b.h) / 2; b.h = minH; }
  const scale = Math.min(2, maxWidth / b.w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(b.w * scale));
  canvas.height = Math.max(1, Math.round(b.h * scale));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, -b.x * scale, -b.y * scale);
  drawSheet(ctx, doc.bg, doc.grid, b, scale);
  for (const s of doc.strokes) drawStroke(ctx, s, doc.bg);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return { blob, width: canvas.width, height: canvas.height };
}
