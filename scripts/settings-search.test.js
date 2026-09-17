/**
 * settings-search.test.js: every setting can be found by searching for it.
 *
 * The Settings search matches what the user types against SECTION_KEYWORDS in
 * src/routes/Settings.svelte, so a setting whose own words aren't in that list
 * can't be found by name. This reads each section's component, takes the text
 * of every setting label and group heading from en.json, and checks each
 * meaningful word is somewhere in that section's keywords.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const en = JSON.parse(read('src/i18n/en.json'));

const settingsSvelte = read('src/routes/Settings.svelte');

/** SECTION_KEYWORDS, as the app has it. */
function keywords() {
  const block = settingsSvelte.slice(settingsSvelte.indexOf('const SECTION_KEYWORDS = {'));
  const end = block.indexOf('\n  };');
  const out = {};
  for (const line of block.slice(0, end).split('\n')) {
    const m = line.match(/^\s{4}([a-z]+):\s*\[(.*)\],?\s*$/);
    if (m) out[m[1]] = [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1].toLowerCase());
  }
  return out;
}

/** Section slug to its component file. */
function components() {
  const block = settingsSvelte.slice(settingsSvelte.indexOf('const SECTION_COMPONENTS = {'));
  const end = block.indexOf('\n  };');
  const byName = Object.fromEntries([...settingsSvelte.matchAll(/import\s+(\w+)\s+from\s+'([^']+\.svelte)'/g)].map(m => [m[1], m[2]]));
  const out = {};
  for (const line of block.slice(0, end).split('\n')) {
    const m = line.match(/^\s{4}([a-z]+):\s*(\w+),/);
    if (m && byName[m[2]]) out[m[1]] = path.join('src/routes', byName[m[2]]).replace(/^src\/routes\/\.\.\//, 'src/');
  }
  return out;
}

const value = (key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), en);

/** The words of every setting label and group heading in a component. */
function labels(file) {
  const src = read(file);
  const out = [];
  for (const line of src.split('\n')) {
    if (!/setting-label|settings-group-heading|sub-label/.test(line)) continue;
    for (const m of line.matchAll(/\$_\('([a-z0-9_.]+)'/g)) {
      const v = value(m[1]);
      if (typeof v === 'string') out.push(v);
    }
  }
  return out;
}

// Words that say nothing about which setting this is.
const SKIP = new Set([
  'the', 'and', 'for', 'with', 'your', 'this', 'that', 'from', 'when', 'what', 'into', 'each', 'only', 'all',
  'show', 'hide', 'use', 'used', 'using', 'set', 'setting', 'settings', 'enable', 'enabled', 'disable',
  'new', 'add', 'added', 'edit', 'open', 'close', 'save', 'saved', 'default', 'options', 'option', 'other',
  'a', 'an', 'in', 'on', 'of', 'to', 'or', 'is', 'it', 'as', 'at', 'by', 'off',
  // Filler that nobody searches for on its own.
  'their', 'include', 'includes', 'turn', 'allow', 'view', 'after', 'long', 'name', 'names', 'more',
]);

const words = (text) => text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
  .filter(w => w.length >= 4 && !SKIP.has(w));

test('every setting can be found from the Settings search bar', () => {
  const kw = keywords();
  const comps = components();
  const missing = [];
  for (const [slug, file] of Object.entries(comps)) {
    if (slug === 'profile') continue; // its own page, with its own keywords
    const haystack = (kw[slug] || []).join(' | ');
    assert.ok(kw[slug], `${slug} has no keywords at all`);
    for (const label of labels(file)) {
      for (const w of words(label)) {
        // A word counts as findable when it appears in any of the section's
        // keywords, whole or as the start of one ("token" finds "tokens").
        if (!haystack.includes(w) && !haystack.includes(w.replace(/s$/, ''))) {
          missing.push(`${slug}: "${label}" (no keyword for "${w}")`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], `Settings search can't find these. Add keywords to SECTION_KEYWORDS in src/routes/Settings.svelte:\n  ${missing.join('\n  ')}`);
});
