import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayLayer, isTopOverlay } from '../src/lib/overlay-layer.js';

globalThis.getComputedStyle = node => ({ zIndex: node.baseline });
const node = baseline => ({ baseline, style: { zIndex: '' } });

test('a calendar with a lower CSS z-index opens above its reminder popover', () => {
  const popover = node('300'), calendar = node('200');
  const parent = overlayLayer(popover), child = overlayLayer(calendar);
  assert.ok(Number(calendar.style.zIndex) > Number(popover.style.zIndex));
  assert.equal(isTopOverlay(popover), false);
  assert.equal(isTopOverlay(calendar), true);
  child.destroy();
  assert.equal(isTopOverlay(popover), true);
  assert.equal(calendar.style.zIndex, '');
  parent.destroy();
  assert.equal(isTopOverlay(popover), false);
});
test('higher baseline layers and nested layers retain their ordering', () => {
  const reminder = node('300'), time = node('9999'), child = node('200');
  const a = overlayLayer(reminder), b = overlayLayer(time), c = overlayLayer(child);
  assert.equal(time.style.zIndex, '9999');
  assert.equal(child.style.zIndex, '10000');
  a.destroy(); // Account/navigation teardown can remove a parent first.
  assert.equal(isTopOverlay(child), true);
  c.destroy(); assert.equal(isTopOverlay(time), true);
  b.destroy();
  const reopened = node('200'), d = overlayLayer(reopened);
  assert.equal(reopened.style.zIndex, '200');
  d.destroy();
});
