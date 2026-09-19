import test from 'node:test';
import assert from 'node:assert/strict';
import { searchTerms, highlightParts, matchSnippet, textHasTerms } from '../src/lib/highlight.js';

test('terms come from the query, one letter words left out', () => {
  assert.deepEqual(searchTerms('Jelly a transcode!'), ['jelly', 'transcode']);
  assert.deepEqual(searchTerms(''), []);
});

test('word beginnings are marked, like the search itself', () => {
  const parts = highlightParts('Move Jellyfin transcodes', ['jelly']);
  assert.deepEqual(parts.map(p => p.text), ['Move ', 'Jelly', 'fin transcodes']);
  assert.deepEqual(parts.map(p => p.hit), [false, true, false]);
  // Not in the middle of a word.
  assert.equal(highlightParts('Pelly jelly', ['elly']).some(p => p.hit), false);
  assert.deepEqual(highlightParts('plain', []), [{ text: 'plain', hit: false }]);
});

test('a snippet shows the match in a longer transcript', () => {
  const long = 'One two three four five six. Remember to call the plumber on Friday about the leak in the basement.';
  const s = matchSnippet(long, ['plumber']);
  assert.match(s, /plumber/);
  assert.ok(s.length < 90 && s.startsWith('…'));
  assert.equal(matchSnippet('', ['x']), '');
});

test('a note whose own text has no match was found by an attachment', () => {
  const note = { title: 'Call log', body_md: 'nothing here', items: [] };
  assert.equal(textHasTerms(note, ['plumber']), false);
  assert.equal(textHasTerms(note, ['call']), true);
  assert.equal(textHasTerms(note, []), true);
});
