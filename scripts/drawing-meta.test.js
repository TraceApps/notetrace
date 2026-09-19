import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDrawing, drawingText, emptyDrawing, strokesBounds, strokeHit, strokesInLasso, pointInPolygon, moveStroke, MAX_STROKES } from '../server/lib/drawing-meta.js';

const line = (x0, y0, x1, y1, extra = {}) => ({ t: 'pen', c: '#1f1f1f', s: 2, p: [x0 * 2, y0 * 2, 50, x1 * 2, y1 * 2, 50], ...extra });

test('a drawing is checked before it is stored', () => {
  const d = parseDrawing(JSON.stringify({ v: 1, w: 1600, h: 1200, bg: 'dark', grid: 'dots', strokes: [line(10, 10, 100, 100)] }));
  assert.equal(d.bg, 'dark');
  assert.equal(d.grid, 'dots');
  assert.equal(d.strokes.length, 1);
  assert.equal(parseDrawing('not json'), null);
  assert.equal(parseDrawing({ v: 2, strokes: [] }), null, 'an unknown version is refused');
  assert.equal(parseDrawing({ v: 1 }), null);
});

test('bad strokes are dropped, odd values made safe', () => {
  const d = parseDrawing({ v: 1, w: 1600, h: 1200, bg: 'neon', grid: 'hex', strokes: [
    line(0, 0, 5, 5, { c: 'javascript:alert(1)' }),
    { t: 'laser', c: '#ff0000', s: 2, p: [1, 2, 3] },
    { t: 'pen', c: '#ff0000', s: 9, p: [1, 2] },
    { t: 'marker', c: '#FF0000', s: 3, p: [1, 'x', 3, 4, 5, 6] },
    { t: 'highlighter', c: '#FFaa00', s: 0, p: [10, 20, 150] },
  ] });
  assert.equal(d.bg, 'paper');
  assert.equal(d.grid, 'none');
  assert.deepEqual(d.strokes.map(s => s.t), ['pen', 'highlighter']);
  assert.equal(d.strokes[0].c, '#1f1f1f', 'a colour that is not a colour becomes ink');
  assert.equal(d.strokes[1].c, '#ffaa00');
  assert.equal(d.strokes[1].s, 1);
  assert.equal(d.strokes[1].p[2], 100, 'pressure is clamped');
});

test('stroke and size limits hold', () => {
  const many = { v: 1, w: 1600, h: 1200, strokes: Array.from({ length: MAX_STROKES + 50 }, (_, i) => line(i % 100, 1, 2, 3)) };
  assert.equal(parseDrawing(many).strokes.length, MAX_STROKES);
  assert.equal(drawingText({ v: 1, strokes: [] }) !== null, true);
  assert.equal(drawingText(null), null);
  assert.equal(emptyDrawing().strokes.length, 0);
});

test('bounds, the eraser, and the lasso', () => {
  const a = line(10, 10, 110, 10), b = line(500, 500, 520, 540);
  assert.deepEqual(strokesBounds([a, b]), { x: 10, y: 10, w: 510, h: 530 });
  assert.equal(strokesBounds([]), null);
  assert.equal(strokeHit(a, 60, 14, 5), true);
  assert.equal(strokeHit(a, 60, 30, 5), false);
  const square = [[0, 0], [200, 0], [200, 200], [0, 200]];
  assert.equal(pointInPolygon(50, 50, square), true);
  assert.equal(pointInPolygon(250, 50, square), false);
  assert.deepEqual(strokesInLasso([a, b], square), [0]);
  const moved = moveStroke(a, 5, -5);
  assert.deepEqual(moved.p.slice(0, 2), [30, 10]);
  assert.deepEqual(a.p.slice(0, 2), [20, 20], 'moving makes a copy');
});
