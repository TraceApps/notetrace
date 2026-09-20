/**
 * Static-analysis tests for the note editor's scrolling layout. Pure text
 * checks, so they run without a browser.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const editor = readFileSync(new URL('../src/components/notes/NoteEditor.svelte', import.meta.url), 'utf8');

test('the editor scroller is a flex column that scrolls', () => {
  const rule = editor.match(/\.editor-scroll \{[^}]*\}/s)?.[0] || '';
  for (const prop of ['display: flex', 'flex-direction: column', 'overflow-y: auto']) {
    assert.ok(rule.includes(prop), `.editor-scroll should set ${prop}`);
  }
});

test('editor scroller children never shrink below their content (#8)', () => {
  // Without this, a note taller than the panel squeezes the editor's own
  // box, its text spills out, and the labels, reminder, share and backlink
  // rows that follow are drawn over the middle of the note.
  assert.match(editor, /\.editor-scroll > :global\(\*\) \{ flex-shrink: 0; \}/);
});
