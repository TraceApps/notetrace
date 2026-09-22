/**
 * Putting a whole checklist back (issue #7).
 *
 * The rules that matter: it is one ordinary tick per item rather than a new
 * kind of write, so it queues and merges like everything else; unchecking
 * never moves a repeating task on, because that rule belongs to ticking one
 * off; and nothing is lost, the items only move back up the list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { itemAfterPatch } from '../server/lib/task-rules.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const editor = read('../src/components/notes/ChecklistEditor.svelte');

test('the checked bar offers to put them all back', () => {
  assert.match(editor, /class="uncheck-all"[\s\S]*?on:click=\{uncheckAll\}/);
  assert.match(editor, /\$_\('notes\.uncheck_all'\)/);
});

test('it is the same write a single tick makes, one per item', () => {
  // Not a new route and not a bulk shape: this is what makes it queue with no
  // connection and merge against whatever else touched the note.
  assert.match(editor, /for \(const item of back\) dispatch\('update', \{ uuid: item\.uuid, patch: \{ checked: false, today \} \}\)/);
});

test('a read-only note is not offered it', () => {
  assert.match(editor, /function uncheckAll\(\) \{\s*\n\s*if \(!editable\) return;/);
  assert.match(editor, /\{#if editable\}\s*\n\s*<button type="button" class="uncheck-all"/);
});

test('unchecking never moves a repeating task on', () => {
  const weekly = { text: 'Bins', checked: true, due_date: '2026-09-21', due_repeat: 'weekly' };
  const back = itemAfterPatch(weekly, { checked: false }, '2026-09-21');
  assert.equal(back.checked, false);
  assert.equal(back.due_date, '2026-09-21', 'its date stays where it was');
  assert.equal(back.due_repeat, 'weekly', 'and it still repeats');
});

test('ticking one off still does move it on, which is the rule being kept apart', () => {
  const weekly = { text: 'Bins', checked: false, due_date: '2026-09-21', due_repeat: 'weekly' };
  const ticked = itemAfterPatch(weekly, { checked: true }, '2026-09-21');
  assert.equal(ticked.checked, false, 'a repeating task moves on rather than being ticked');
  assert.notEqual(ticked.due_date, '2026-09-21');
});

test('the label exists in English', () => {
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(typeof en.notes.uncheck_all, 'string');
});
