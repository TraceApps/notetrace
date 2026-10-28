/**
 * Page banners: white text read at about 2:1 in the light theme and on light
 * accents in the dark one (TraceApps/notetrace#39). The banner's text color
 * now comes from the banner itself: white where it reads well, near-black
 * where it doesn't.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { bannerTextColor, bannerColor, luminance, contrast, parseColor, LIGHT, DARK } from '../src/lib/banner-text.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const DARK_THEME = { glass: 'rgba(18, 20, 26, 0.88)', bg: '#0A0B0F' };
const LIGHT_THEME = { glass: 'rgba(255, 255, 255, 0.88)', bg: '#F5F7FA' };
const pick = (accent, accent2, theme) => bannerTextColor(accent, accent2, theme.glass, theme.bg);
const ratio = (accent, accent2, theme, text) => contrast(luminance(parseColor(text)), luminance(bannerColor(accent, accent2, theme.glass, theme.bg)));

test('colors are read as the browser gives them', () => {
  assert.deepEqual(parseColor('#7C5CE0'), [124, 92, 224, 1]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('rgba(18, 20, 26, 0.88)'), [18, 20, 26, 0.88]);
  assert.deepEqual(parseColor('rgb(1 2 3)'), [1, 2, 3, 1]);
  assert.equal(parseColor(''), null);
  assert.equal(pick('', '', LIGHT_THEME), LIGHT, 'nothing to go on: white, as before');
});

test('white stays where it reads well: the default dark theme and dark accents', () => {
  assert.equal(pick('#B69CFF', '#7FA8FF', DARK_THEME), LIGHT, 'lavender, dark theme (the default)');
  assert.equal(pick('#1E3A8A', '#1E3A8A', DARK_THEME), LIGHT);
  assert.equal(pick('#4FC3F7', '#7986CB', DARK_THEME), LIGHT, 'blue, dark theme');
});

// The 3:1 check below is against the same estimate the pick uses, so it
// shows the rule is consistent, not what a browser draws: measured in
// Chromium (blur, saturation and gradient included), every theme and accent
// read at 3.2:1 or better at the darkest tenth of the title's background.
test('light theme and light accents get near-black, and by the estimate every pick is 3:1 or better', () => {
  assert.equal(pick('#7C5CE0', '#4F6FD8', LIGHT_THEME), DARK, 'lavender, light theme');
  assert.equal(pick('#00C47A', '#0099CC', LIGHT_THEME), DARK, 'mint, light theme');
  assert.equal(pick('#FFE066', '#FFE066', LIGHT_THEME), DARK, 'a light custom color');
  assert.equal(pick('#1E3A8A', '#1E3A8A', LIGHT_THEME), DARK, 'navy, light theme: white was 3.3:1, near-black about 6:1');
  assert.equal(pick('#4FFFB0', '#00C9FF', DARK_THEME), DARK, 'mint, dark theme');
  assert.equal(pick('#FFF176', '#FFD54F', DARK_THEME), DARK, 'yellow, dark theme');
  assert.equal(pick('#80DEEA', '#4DD0E1', DARK_THEME), DARK, 'cyan, dark theme: white measured 3.15:1');
  for (const theme of [DARK_THEME, LIGHT_THEME]) {
    for (const accent of ['#B69CFF', '#7C5CE0', '#4FFFB0', '#00C47A', '#4FC3F7', '#0277BD', '#FF7070', '#FFB547', '#FFF176', '#C5E1A5', '#80DEEA', '#FFE066', '#1E3A8A', '#000000', '#FFFFFF']) {
      const text = pick(accent, accent, theme);
      assert.ok(ratio(accent, accent, theme, text) >= 3, `${accent} on ${theme.bg}: ${text}, by the estimate`);
    }
  }
});

test('banner text, icons and the Notes search follow it, and it is set with the accent and the theme', () => {
  const css = read('../src/styles/base.css');
  for (const style of ['gradient', 'animated']) {
    const rule = css.slice(css.indexOf(`.page-header.banner-${style} h1 {`)).split('}')[0];
    assert.match(rule, /-webkit-text-fill-color: var\(--banner-text, #fff\);/);
    assert.match(rule, /\bcolor: var\(--banner-text, #fff\);/);
  }
  assert.doesNotMatch(css.slice(css.indexOf('.page-header.banner-gradient .btn-icon,')).split('/* Page shell')[0], /color: #fff/);
  const notes = read('../src/routes/Notes.svelte');
  assert.doesNotMatch(notes, /\.notes-header\.banner-gradient[^\n]*(?<!background: |border-color: )rgba\(255, 255, 255, 0\.(92|72|8)\)/);
  assert.match(notes, /header-search input \{ color: var\(--banner-text, #fff\); \}/);
  const settings = read('../src/stores/settings.js');
  assert.equal((settings.match(/\n  applyBannerText\(\);\n/g) || []).length, 2, 'after the accent and after the theme');
  assert.match(read('../src/main.js'), /data-theme', e\.matches \? 'dark' : 'light'\);[\s\S]{0,200}applyBannerText\(\);/, 'and when the system theme flips');
});
