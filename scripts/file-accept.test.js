/**
 * The Android app's file picker turns each extension in an accept list
 * into a MIME type and drops the ones Android doesn't know (.enex, .bko),
 * so an Evernote export or a Blinko backup was greyed out (the same bug as
 * cooktrace#98). In the app those pickers now show every file and check
 * the pick themselves; the browser keeps its filter. file-accept.js is
 * shared with CookTrace and kept identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickerAccept, fileMatchesAccept } from '../src/lib/file-accept.js';

const EVERNOTE = '.enex,.zip,application/zip,application/xml,text/xml';
const BLINKO = '.bko,.zip,application/zip';

test('the app shows every file, the browser keeps the list', () => {
  assert.equal(pickerAccept(EVERNOTE, true), '');
  assert.equal(pickerAccept(EVERNOTE, false), EVERNOTE);
});

test('Evernote exports and Blinko backups pass, as Android reports them', () => {
  assert.ok(fileMatchesAccept({ name: 'My Notes.enex', type: 'application/octet-stream' }, EVERNOTE));
  assert.ok(fileMatchesAccept({ name: 'NOTES.ENEX', type: '' }, EVERNOTE));
  assert.ok(fileMatchesAccept({ name: 'notebooks.zip', type: 'application/zip' }, EVERNOTE));
  assert.ok(fileMatchesAccept({ name: 'export', type: 'text/xml' }, EVERNOTE), 'no extension, passes on its type');
  assert.ok(fileMatchesAccept({ name: 'backup.bko', type: 'application/octet-stream' }, BLINKO));
});

test('other files are refused', () => {
  assert.ok(!fileMatchesAccept({ name: 'photo.jpg', type: 'image/jpeg' }, EVERNOTE));
  assert.ok(!fileMatchesAccept({ name: 'notes.enex.txt', type: 'text/plain' }, EVERNOTE));
  assert.ok(!fileMatchesAccept({ name: 'My Notes.enex', type: 'application/octet-stream' }, BLINKO));
  assert.ok(!fileMatchesAccept(null, BLINKO));
});

test('the Evernote and Blinko pickers use the helper, checked in the app only', () => {
  const src = readFileSync(new URL('../src/components/settings/SettingsImportExport.svelte', import.meta.url), 'utf8');
  assert.match(src, /accept=\{pickerAccept\(EVERNOTE_ACCEPT, isNative\)\}/);
  assert.match(src, /accept=\{pickerAccept\(BLINKO_ACCEPT, isNative\)\}/);
  assert.doesNotMatch(src, /accept="[^"]*\.(enex|bko)/);
  assert.match(src, /isNative && CHECKED_ACCEPT\[source\] && !fileMatchesAccept\(/);
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  assert.ok(en.import_export.wrong_evernote_file && en.import_export.wrong_blinko_file);
});
