/**
 * Putting a whole checklist back, and clearing out what is done (issue #7).
 *
 * The rules that matter: both are ordinary per-item writes underneath rather
 * than a new kind of write, so they queue and merge like everything else; one
 * line of undo covers the whole action rather than one per item; unchecking
 * never moves a repeating task on, because that rule belongs to ticking one
 * off; and nothing is lost that an undo cannot put back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { itemAfterPatch } from '../server/lib/task-rules.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const editor = read('../src/components/notes/ChecklistEditor.svelte');
const note = read('../src/components/notes/NoteEditor.svelte');

test('the checked bar offers both ways to clear it', () => {
  assert.match(editor, /class="uncheck-all"[\s\S]*?on:click=\{uncheckAll\}/);
  assert.match(editor, /class="delete-checked"[\s\S]*?on:click=\{deleteChecked\}/);
  assert.match(editor, /\$_\('notes\.uncheck_all'\)/);
  assert.match(editor, /\$_\('notes\.delete_checked'\)/);
});

test('each is one event for the lot, not one per item', () => {
  // One event means one line of undo. Twenty toasts for twenty items is the
  // thing this shape is avoiding.
  assert.match(editor, /dispatch\('uncheck-all', \{ uuids: back\.map\(i => i\.uuid\) \}\)/);
  assert.match(editor, /dispatch\('delete-checked', \{ items: gone\.map\(i => \(\{ \.\.\.i \}\)\) \}\)/);
  assert.match(note, /on:uncheck-all=\{onUncheckAll\} on:delete-checked=\{onDeleteChecked\}/);
});

test('underneath it is the same write a single tap makes', () => {
  // Not a new route and not a bulk shape: this is what makes it queue with no
  // connection and merge against whatever else touched the note.
  assert.match(note, /onUncheckAll[\s\S]*?NoteApi\.updateItem\(noteId, uuid, \{ checked: false, today \}\)/);
  assert.match(note, /onDeleteChecked[\s\S]*?NoteApi\.deleteItem\(noteId, item\.uuid\)/);
});

test('both can be undone, and the undo puts back exactly what went', () => {
  assert.match(note, /showUndo\(\$_\('notes\.undo_uncheck_all'\), \(\) => recheck\(uuids\)\)/);
  assert.match(note, /showUndo\(\$_\('notes\.undo_delete_checked'[\s\S]*?\) => restoreChecked\(gone\)\)/);
  // Re-checking only the ones that were unchecked, not everything: something
  // may have been ticked in the meantime.
  assert.match(note, /function recheck\(uuids\)[\s\S]*?uuids\.includes\(i\.uuid\)/);
  // A deleted item comes back checked, where it was, with its date.
  assert.match(note, /uuid: item\.uuid, text: item\.text, checked: true,\s*\n\s*position: item\.position, due_date: item\.due_date \|\| null,/);
});

test('a read-only note is offered neither', () => {
  assert.match(editor, /function uncheckAll\(\) \{\s*\n\s*if \(!editable\) return;/);
  assert.match(editor, /function deleteChecked\(\) \{\s*\n\s*if \(!editable\) return;/);
  assert.match(editor, /\{#if editable\}\s*\n\s*<div class="checked-actions">/);
});

test('unchecking never moves a repeating task on', () => {
  const weekly = { text: 'Bins', checked: true, due_date: '2026-09-21', due_repeat: 'weekly' };
  const back = itemAfterPatch(weekly, { checked: false }, '2026-09-21');
  assert.equal(back.checked, false);
  assert.equal(back.due_date, '2026-09-21', 'its date stays where it was');
  assert.equal(back.due_repeat, 'weekly', 'and it still repeats');
});

test('ticking one off still does move it on, which is why it is never in the checked list', () => {
  const weekly = { text: 'Bins', checked: false, due_date: '2026-09-21', due_repeat: 'weekly' };
  const ticked = itemAfterPatch(weekly, { checked: true }, '2026-09-21');
  assert.equal(ticked.checked, false, 'a repeating task moves on rather than being ticked');
  assert.notEqual(ticked.due_date, '2026-09-21');
});

test('the labels exist in English', () => {
  const en = JSON.parse(read('../src/i18n/en.json'));
  for (const k of ['uncheck_all', 'delete_checked', 'undo_uncheck_all', 'undo_delete_checked']) {
    assert.equal(typeof en.notes[k], 'string', k);
  }
});
