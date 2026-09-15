import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldFromFeatures, foldFromSegments, sizeClassFor } from '../src/lib/fold-core.js';

test('size classes', () => {
  assert.equal(sizeClassFor(344), 'compact');
  assert.equal(sizeClassFor(599), 'compact');
  assert.equal(sizeClassFor(600), 'medium');
  assert.equal(sizeClassFor(882), 'medium');
  assert.equal(sizeClassFor(1024), 'expanded');
});

test('a flat fold is ignored; half open gives book or tabletop', () => {
  const f = (state, orientation, extra = {}) => ({ features: [{ state, orientation, separating: false, left: 440, right: 442, top: 0, bottom: 1104, ...extra }] });
  assert.equal(foldFromFeatures(f('flat', 'vertical')), null);
  assert.deepEqual(foldFromFeatures(f('half_opened', 'vertical')), { posture: 'book', start: 440, end: 442 });
  assert.deepEqual(foldFromFeatures(f('half_opened', 'horizontal', { left: 0, right: 1104, top: 441, bottom: 441 })), { posture: 'tabletop', start: 441, end: 441 });
  assert.deepEqual(foldFromFeatures(f('flat', 'vertical', { separating: true })), { posture: 'book', start: 440, end: 442 });
  assert.equal(foldFromFeatures({ features: [] }), null);
  assert.equal(foldFromFeatures(null), null);
});

test('viewport segments', () => {
  assert.equal(foldFromSegments([{ x: 0, y: 0, width: 800, height: 600 }]), null);
  assert.deepEqual(foldFromSegments([{ x: 0, y: 0, width: 400, height: 900 }, { x: 420, y: 0, width: 400, height: 900 }]), { posture: 'book', start: 400, end: 420 });
  assert.deepEqual(foldFromSegments([{ x: 0, y: 0, width: 900, height: 400 }, { x: 0, y: 400, width: 900, height: 400 }]), { posture: 'tabletop', start: 400, end: 400 });
});
