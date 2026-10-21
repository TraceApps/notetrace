import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleToolbarCount } from '../src/lib/toolbar-fit.js';

test('wide note panes show all eligible actions', () => {
  assert.equal(visibleToolbarCount(1280, 19), 19);
  assert.equal(visibleToolbarCount(960, 15), 15);
});

test('shrinking panes progressively move actions into More', () => {
  const counts = [1000, 900, 800, 700, 600].map(width => visibleToolbarCount(width, 19));
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] <= counts[i - 1]);
  assert.ok(new Set(counts).size >= 4);
});

test('phone toolbars reserve room for touch-sized More and Close buttons', () => {
  assert.equal(visibleToolbarCount(360, 19), 4);
  assert.equal(visibleToolbarCount(320, 19), 3);
  assert.equal(visibleToolbarCount(180, 19), 0);
});

test('the count remains bounded when actions disappear or before layout measures', () => {
  assert.equal(visibleToolbarCount(0, 19), 0);
  assert.equal(visibleToolbarCount(1280, 0), 0);
  assert.equal(visibleToolbarCount(360, 2), 2);
});
