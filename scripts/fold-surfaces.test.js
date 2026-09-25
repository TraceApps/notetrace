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
import { execSync } from 'node:child_process';

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

test('the rules name classes this app actually has', () => {
  // A rule written against another Trace app's class names would be silently
  // dead here, which is the one failure a stylesheet never reports.
  const used = [...css.matchAll(/html\.fold-(?:book|tabletop) ([^{]+)\{/g)]
    .flatMap(m => m[1].split(',').map(x => x.trim()))
    .flatMap(sel => sel.match(/\.[a-z-]+/g) || []);
  const src = ['src/components', 'src/routes', 'src/styles']
    .map(d => new URL(`../${d}/`, import.meta.url).pathname);
  for (const sel of new Set(used)) {
    const hits = execSync(`grep -rl "${sel.slice(1)}" ${src.join(' ')} || true`, { encoding: 'utf8' }).trim();
    assert.ok(hits, `${sel} is not used anywhere in this app`);
  }
});
