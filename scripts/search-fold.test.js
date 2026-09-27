/**
 * Search folding, client and server.
 *
 * The server's full-text index is declared `remove_diacritics 2`, so a search
 * for "cafe" already finds a note that says "Café". Everything around it had
 * to learn the same rule: the label picker, the [[link]] autocomplete, the
 * match highlighting, Settings search, and the on-device SQLite search that
 * local mode uses in place of the index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { foldText, stripAccents, includesFolded, coversFolded } from '../src/lib/search-text.js';
import { foldText as serverFoldText } from '../server/lib/search-text.js';
import { searchTerms, highlightParts, matchSnippet, textHasTerms } from '../src/lib/highlight.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// The engine the server runs, better-sqlite3, built for the Node in CI and
// the image; Node's own SQLite where that binary doesn't match the local Node
// (node:sqlite is missing from Node 20).
async function openDb() {
  try {
    const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
    return new Database(':memory:');
  } catch {}
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(':memory:');
  } catch {}
  return null;
}

const SAMPLES = [
  'Café', 'Répétition', 'Mañana', 'Almoço', 'Rückblick', 'Łosoś', 'Straße',
  'Grocery list', 'TODO', '', null, undefined, 42,
];

test('the client and server copies fold identically', () => {
  for (const s of SAMPLES) assert.equal(serverFoldText(s), foldText(s), `differs for ${String(s)}`);
});

test('folding drops accents and leaves plain text alone', () => {
  assert.equal(foldText('Répétition'), 'repetition');
  assert.equal(foldText('Mañana'), 'manana');
  assert.equal(foldText('Grocery List'), 'grocery list');
  assert.equal(foldText('Straße'), 'strasse');
});

test('stripAccents leaves those letters alone, the way SQL engines do', () => {
  assert.equal(stripAccents('Straße'), 'straße');
  assert.equal(stripAccents('Répétition'), 'repetition');
});

test('folding is idempotent and never throws on junk', () => {
  for (const s of SAMPLES) assert.equal(foldText(foldText(s)), foldText(s));
  assert.equal(foldText(null), '');
});

test('includesFolded and coversFolded ignore accents', () => {
  assert.ok(includesFolded('Almoço de domingo', 'almoco'));
  assert.ok(includesFolded('Almoco de domingo', 'almoço'));
  assert.ok(coversFolded('Répétition du mardi', 'mardi repetition'));
  assert.ok(!coversFolded('Répétition', 'mardi'));
});

test('a term without accents highlights the accented spelling', () => {
  assert.deepEqual(searchTerms('Café crème'), ['cafe', 'creme']);
  const parts = highlightParts('Café crème at noon', searchTerms('cafe'));
  assert.deepEqual(parts.map(p => p.text), ['Café', ' crème at noon']);
  assert.deepEqual(parts.map(p => p.hit), [true, false]);
  // Still only word beginnings.
  assert.equal(highlightParts('Précafé', ['cafe']).some(p => p.hit), false);
});

test('the snippet and the own-text check fold too', () => {
  const long = 'Un deux trois quatre cinq six. Ne pas oublier la répétition de mardi soir.';
  assert.match(matchSnippet(long, ['repetition']), /répétition/);
  const note = { title: 'Mañana', body_md: 'almoço com a família', items: [] };
  assert.equal(textHasTerms(note, ['almoco']), true);
  assert.equal(textHasTerms(note, ['jantar']), false);
});

test('the on-device search folds as a fallback, the way the index does', async (t) => {
  // The same SQL shape notes-native.js builds for local mode, run for real.
  const src = read('../src/lib/notes-native.js');
  assert.match(src, /_searchClause\(q, \{ folded: true \}\)/, 'the folded retry is wired up');
  assert.match(src, /if \(!rows\.length && search\.sql\)/, 'and only runs when nothing matched');

  const db = await openDb();
  if (!db) return t.skip('no SQLite engine loads under this Node');
  db.exec('CREATE TABLE notes (title TEXT)');
  db.prepare('INSERT INTO notes VALUES (?)').run('Répétition');
  const plain = db.prepare('SELECT title FROM notes WHERE title LIKE ?').all('%repetition%');
  assert.equal(plain.length, 0, 'plain LIKE cannot match the accented title');
  const folded = db.prepare(
    `SELECT title FROM notes WHERE REPLACE(REPLACE(LOWER(title), 'é', 'e'), 'è', 'e') LIKE ?`
  ).all('%repetition%');
  assert.equal(folded.length, 1, 'the folded expression does');
});

test('the note index itself strips diacritics', () => {
  assert.match(read('../server/db.js'), /tokenize = 'unicode61 remove_diacritics 2'/);
});

test('no search box compares raw lowercase text any more', () => {
  const swept = [
    '../src/components/notes/LabelPicker.svelte',
    '../src/components/notes/TipTapEditor.svelte',
    '../src/routes/Settings.svelte',
  ];
  for (const p of swept) {
    const src = read(p);
    assert.doesNotMatch(src, /\.toLowerCase\(\)\.includes\(/, `${p} still compares unfolded text`);
    assert.match(src, /foldText\(/, `${p} should use the shared fold`);
  }
});
