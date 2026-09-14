/**
 * Static-analysis tests for the notes data layer. Pure text checks, no
 * db.js import, so they run without a compiled better-sqlite3 binding.
 * Behavior is covered end to end by scripts/notes-api-smoke.mjs against
 * a running server.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const indexJs = read('../server/index.js');
const dbJs    = read('../server/db.js');
const syncJs  = read('../server/routes/sync.js');
const notesJs = read('../server/lib/notes.js');
const backup  = read('../server/routes/full-backup.js');
const sched   = read('../server/lib/scheduler.js');

test('notes and labels routes are mounted', () => {
  assert.match(indexJs, /router\.use\('\/api\/notes',\s+notesRoutes\)/);
  assert.match(indexJs, /router\.use\('\/api\/labels',\s+labelsRoutes\)/);
});

test('checklist items are rows keyed by a unique uuid, never a replaced list', () => {
  assert.match(dbJs, /CREATE TABLE IF NOT EXISTS checklist_items[\s\S]*?uuid\s+TEXT NOT NULL UNIQUE/);
  assert.doesNotMatch(notesJs, /DELETE FROM checklist_items/, 'items must be tombstoned, not hard-deleted, so deletes sync');
});

test('search index is maintained by triggers on notes and checklist_items', () => {
  for (const t of ['trg_notes_fts_ins', 'trg_notes_fts_upd', 'trg_notes_fts_del', 'trg_items_fts_ins', 'trg_items_fts_upd', 'trg_items_fts_del']) {
    assert.match(dbJs, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${t}`));
  }
});

test('search input is reduced to quoted prefix terms before reaching FTS5', () => {
  assert.match(notesJs, /export function ftsQuery/);
  assert.match(notesJs, /notes_fts MATCH \?/);
});

test('sync covers every note table in parent-first order', () => {
  const order = syncJs.match(/const PUSH_ORDER = \[([^\]]+)\]/)[1];
  const names = [...order.matchAll(/'(\w+)'/g)].map(m => m[1]);
  for (const t of ['notes', 'labels', 'checklist_items', 'note_attachments', 'note_labels']) assert.ok(names.includes(t), `${t} missing from PUSH_ORDER`);
  // Parents before children.
  assert.ok(names.indexOf('notes') < names.indexOf('checklist_items'));
  assert.ok(names.indexOf('notes') < names.indexOf('note_attachments'));
  assert.ok(names.indexOf('labels') < names.indexOf('note_labels'));
});

test('sync checks that a pushed parent id belongs to the same owner', () => {
  assert.match(syncJs, /SELECT user_id FROM \$\{parentTable\} WHERE id = \?/);
});

test('sync never lets an older device copy overwrite a newer server row', () => {
  assert.match(syncJs, /serverIsNewer/);
  assert.match(syncJs, /snapshotVersion\(existing, 'conflict'/);
});

test('backup dumps and restores every note table', () => {
  // Derived from the schema so a new note table can't be left out of backups.
  const noteTables = [...dbJs.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n  \);/g)]
    .filter(([, name, body]) => name === 'notes' || name === 'labels' || /\bnote_id\b/.test(body))
    .map(([, name]) => name);
  assert.ok(noteTables.includes('note_members'), `schema parse found ${noteTables}`);
  for (const t of noteTables) {
    assert.match(backup, new RegExp(`DELETE FROM ${t}'`), `${t} not wiped before restore`);
    assert.match(backup, new RegExp(`_selectIfExists\\('${t}'\\)|SELECT \\* FROM ${t}`), `${t} missing from dump`);
    assert.match(backup, new RegExp(`_bulkRestoreSchemaDriven\\('${t}'`), `${t} missing from restore`);
  }
});

test('the scheduler purges trash past the retention window', () => {
  assert.match(sched, /purgeExpiredTrash\(\)/);
  assert.match(notesJs, /TRASH_RETENTION_DAYS = 30/);
});

test('pulls use the server-stamped synced_at cursor, never device updated_at', () => {
  assert.match(syncJs, /synced_at >= \?/);
  assert.doesNotMatch(syncJs, /AND updated_at > \?/, 'a device-supplied timestamp as pull cursor misses offline edits');
  assert.match(dbJs, /trg_\$\{t\}_synced_upd AFTER UPDATE/);
});

test('a rejected stale push re-stamps the winning row so the device pulls it back', () => {
  assert.match(syncJs, /if \(serverIsNewer\) \{[\s\S]{0,300}SET synced_at = /);
});

test('Android reminders are native exact alarms, re-armed after reboot', () => {
  const manifest = read('../android/app/src/main/AndroidManifest.xml');
  const main = read('../android/app/src/main/java/com/notetrace/app/MainActivity.java');
  const sched = read('../android/app/src/main/java/com/notetrace/app/NoteReminderScheduler.java');
  const js = read('../src/lib/note-reminders.js');
  assert.match(manifest, /android:name="\.NoteReminderReceiver"/);
  assert.match(manifest, /android:name="\.BootReceiver"[\s\S]*BOOT_COMPLETED[\s\S]*TIMEZONE_CHANGED/);
  assert.match(main, /registerPlugin\(NoteRemindersPlugin\.class\)/);
  assert.match(sched, /setExactAndAllowWhileIdle/);
  // The database file the native side reads must match the JS connection name.
  assert.match(read('../src/lib/db-native.js'), /const DB_NAME = 'notetrace_local'/);
  assert.match(sched, /"notetrace_localSQLite\.db"/);
  assert.doesNotMatch(js, /LocalNotifications\.schedule\(/, 'JS must not schedule reminders alongside the native alarms');
});
