import test from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { textSizeCss } from './text-size-css.js';
import { applyTextSize } from '../src/lib/font-themes.js';

test('the size preference clamps unsafe values and resets to the original scale', () => {
  const values = new Map();
  const root = { style: { setProperty: (key,value) => values.set(key,value) } };
  for (const [value, expected] of [[15,1],[18,1.2],[22,22/15],[99,22/15],[-1,0.8],['url(bad)',1]]) {
    applyTextSize(value,root); assert.equal(Number(values.get('--text-scale')),expected);
  }
});

test('text sizing scales pixel text without scaling icon glyphs or doubling inherited sizing', async () => {
  const css = '.note {font-size:15px}.preview h3{font-size:26px}.material-symbols-rounded{font-size:22px}.icon-btn span{font-size:20px}.nested{font-size:1em}';
  const result = await postcss([textSizeCss()]).process(css,{from:undefined});
  assert.ok(result.css.includes('font-size:calc(15px * var(--text-scale, 1))'));
  assert.ok(result.css.includes('font-size:calc(26px * var(--text-scale, 1))'));
  assert.ok(result.css.includes('.material-symbols-rounded{font-size:22px}'));
  assert.ok(result.css.includes('.icon-btn span{font-size:20px}'));
  assert.ok(result.css.includes('.nested{font-size:1em}'));
  const repeat = await postcss([textSizeCss()]).process(result.css,{from:undefined});
  assert.equal(repeat.css,result.css);
});
