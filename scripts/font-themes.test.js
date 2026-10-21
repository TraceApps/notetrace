import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { FONT_THEMES, fontThemeFor, applyFontTheme } from '../src/lib/font-themes.js';

test('font themes apply both UI and note-title families, and restore the original pair', () => {
  const values = new Map();
  const root = { style: { setProperty: (key, value) => values.set(key, value) } };
  for (const theme of FONT_THEMES) {
    applyFontTheme(theme.id, root);
    assert.equal(values.get('--font-sans'), theme.body);
    assert.equal(values.get('--font-note-title'), theme.title || theme.body);
  }
  applyFontTheme('default', root);
  assert.match(values.get('--font-sans'), /Inter/);
  assert.match(values.get('--font-note-title'), /Newsreader/);
});
test('unknown or malformed stored preferences cannot inject CSS', () => {
  for (const value of [undefined, null, {}, 'unavailable', 'url(https://example.test)']) {
    assert.equal(fontThemeFor(value).id, 'default');
  }
});
test('every new font family ships local WOFF2 data and its license', () => {
  const css = readFileSync(new URL('../public/fonts/fonts.css', import.meta.url), 'utf8');
  for (const [family, slug] of FONT_THEMES.filter(theme => theme.assetSlug).map(theme => [theme.name, theme.assetSlug])) {
    assert.ok(css.includes(`font-family: '${family}'`));
    const binary = readFileSync(new URL(`../public/fonts/${slug}-latin.woff2`, import.meta.url));
    assert.equal(binary.toString('ascii', 0, 4), 'wOF2');
    const license = readFileSync(new URL(`../public/fonts/${slug}-OFL.txt`, import.meta.url), 'utf8');
    assert.match(license, /SIL OPEN FONT LICENSE/);
  }
  for (const [, file] of css.matchAll(/url\(\.\/([^)]+)\)/g)) {
    assert.ok(existsSync(new URL(`../public/fonts/${file}`, import.meta.url)), file);
  }
});
