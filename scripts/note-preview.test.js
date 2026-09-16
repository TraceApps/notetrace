import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToPreview } from '../src/lib/note-preview.js';

test('checkboxes in a text note show as boxes on the card', () => {
  assert.equal(markdownToPreview('Before we go:\n- [ ] Plants\n- [x] Camera'), 'Before we go:\n☐ Plants\n☑ Camera');
});

test('highlighted text shows without its marks', () => {
  assert.equal(markdownToPreview('Pack the ==good== snacks'), 'Pack the good snacks');
});
