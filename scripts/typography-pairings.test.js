import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { FONT_PAIRINGS } from '../src/lib/font-pairings.js';
import { applyFontTheme, FONT_THEMES } from '../src/lib/font-themes.js';
import { createFontPreviewLoader } from '../src/lib/font-preview.js';
import { localFontBlocks } from './font-css.js';

test('all 34 requested pairings map their display, body, and mono families to the theme', () => {
  assert.equal(FONT_PAIRINGS.length, 34);
  assert.equal(new Set(FONT_THEMES.map(t => t.id)).size, FONT_THEMES.length);
  const values = new Map();
  for (const theme of FONT_PAIRINGS) {
    applyFontTheme(theme.id, { style: { setProperty: (key, value) => values.set(key, value) } });
    assert.ok(values.get('--font-sans').includes(theme.bodyName));
    assert.ok(values.get('--font-display').includes(theme.displayName));
    assert.ok(values.get('--font-note-title').includes(theme.displayName));
    assert.ok(values.get('--font-mono').includes(theme.monoName));
  }
});

test('every pairing family has real font faces and a bundled redistribution license', () => {
  const css = readFileSync(new URL('../public/fonts/fonts.css', import.meta.url), 'utf8');
  const licenses = readFileSync(new URL('../LICENSES.md', import.meta.url), 'utf8');
  for (const name of new Set(FONT_PAIRINGS.flatMap(p => [p.displayName, p.bodyName, p.monoName]))) {
    assert.ok(css.includes(`font-family: '${name}';`), name);
    assert.ok(licenses.includes(`**${name}**`), name);
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    // Existing families have retained their earlier filenames.
    const old = { 'Plus Jakarta Sans': 'jakarta', 'Source Sans 3': 'source-sans', 'Cormorant Garamond': 'cormorant', 'JetBrains Mono': 'jetbrains', 'Open Sans': 'open-sans', 'Work Sans': 'work-sans', 'Fira Code': 'fira-code' };
    const prefix = old[name] || slug;
    const ofl = new URL(`../public/fonts/${prefix}-OFL.txt`, import.meta.url);
    const apache = new URL(`../public/fonts/${prefix}-LICENSE.txt`, import.meta.url);
    assert.match(readFileSync(existsSync(ofl) ? ofl : apache, 'utf8'), /SIL OPEN FONT LICENSE|Apache License/i, name);
  }
});

test('static regular and bold faces never overwrite each other', () => {
  const block = weight => `/* latin */\n@font-face { font-family: 'Lato'; font-style: normal; font-weight: ${weight}; src: url(https://fonts.example/${weight}.woff2); unicode-range: U+0-FF; }`;
  const faces = localFontBlocks(block(400) + block(700), 'lato');
  assert.equal(faces.length, 2);
  assert.notEqual(faces[0].file, faces[1].file);
  assert.ok(faces[0].css.includes('font-weight: 400;'));
  assert.ok(faces[1].css.includes('font-weight: 700;'));
});

test('a missing font definition is reported instead of silently showing a fallback preview', async () => {
  const states = [];
  const loader = createFontPreviewLoader({ load: async () => [] }, state => states.push(state));
  await loader.load(FONT_PAIRINGS[0]);
  assert.deepEqual(states, ['loading', 'failed']);
});

test('font errors and superseded loads cannot mark another selection ready', async () => {
  const pending = [], states = [];
  const loader = createFontPreviewLoader({ load: () => new Promise(resolve => pending.push(resolve)) }, state => states.push(state));
  const first = loader.load(FONT_PAIRINGS[0]);
  const split = pending.length;
  const second = loader.load(FONT_PAIRINGS.find(p => p.id === 'pair-terminal'));
  pending.slice(split).forEach(resolve => resolve([{ status: 'loaded' }])); await second;
  pending.slice(0, split).forEach(resolve => resolve([])); await first;
  assert.equal(states.at(-1), 'ready');
  const failure = createFontPreviewLoader({ load: async () => { throw Error('offline'); } }, state => states.push(state));
  await failure.load(FONT_PAIRINGS[0]); assert.equal(states.at(-1), 'failed');
});
