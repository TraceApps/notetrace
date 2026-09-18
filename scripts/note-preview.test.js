import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToPreview } from '../src/lib/note-preview.js';

test('checkboxes in a text note show as boxes on the card', () => {
  assert.equal(markdownToPreview('Before we go:\n- [ ] Plants\n- [x] Camera'), 'Before we go:\n☐ Plants\n☑ Camera');
});

test('highlighted text shows without its marks', () => {
  assert.equal(markdownToPreview('Pack the ==good== snacks'), 'Pack the good snacks');
  assert.equal(markdownToPreview('A ++firm++ date'), 'A firm date');
});

test('the server strips Markdown for small screens', async () => {
  const { plainExcerpt } = await import('../server/lib/note-excerpt.js');
  assert.equal(plainExcerpt('## Title\n\n**bold** and _thin_ and `code`'), 'Title\nbold and thin and code');
  assert.equal(plainExcerpt('- one\n- two'), '\u2022 one\n\u2022 two');
  assert.equal(plainExcerpt('- [ ] open\n- [x] done'), '\u2610 open\n\u2611 done');
  assert.equal(plainExcerpt('[a link](https://example.com) and [[Another note]]'), 'a link and Another note');
  assert.equal(plainExcerpt(''), '');
  assert.ok(plainExcerpt('x'.repeat(2000)).endsWith('\u2026'));
});
