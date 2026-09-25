/**
 * Every surface that cannot move itself off a crease has a rule that does.
 *
 * A scrolling list is fine across a fold: you can nudge it. A fixed panel, a
 * canvas or a menu cannot be nudged, so each one needs saying somewhere. This
 * is the list of the ones that have been dealt with, so a new one is noticed
 * when it is added rather than when someone unfolds a phone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles/fold.css', import.meta.url), 'utf8');

test('the book rules cover every fixed surface', () => {
  for (const sel of ['.editor-backdrop', '.dialog-backdrop', '.sheet-backdrop', '.viewer', '.panel']) {
    assert.match(css, new RegExp(`html\\.fold-book [^{]*\\${sel}`), `book: ${sel}`);
  }
});

test('the tabletop rules cover every fixed surface', () => {
  for (const sel of ['.editor-panel', '.dialog-backdrop', '.viewer', '.panel']) {
    assert.match(css, new RegExp(`html\\.fold-tabletop [^{]*\\${sel}`), `tabletop: ${sel}`);
  }
});

test('a canvas is left free to use the whole screen', () => {
  // A workspace you pan and zoom is not a panel that cannot be moved: an
  // opened foldable is a bigger sheet to draw on, which is the point of one.
  assert.doesNotMatch(css, /\.dw-stage/);
  assert.doesNotMatch(css, /fold-tabletop \.dw \{/);
});

test('the rules use the reported crease, never a guess at where it is', () => {
  // Hard-coded halves would be wrong on every device but the one they were
  // written on.
  assert.doesNotMatch(css, /50vw|50dvw|50%\s*\)/);
  assert.match(css, /var\(--fold-start\)/);
  assert.match(css, /var\(--fold-end\)/);
});
