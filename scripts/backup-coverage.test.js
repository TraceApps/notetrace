/**
 * backup-coverage.test.js: everything that can be backed up is.
 *
 * Reads the schemas and the backup code as text (no database needed) and
 * checks every table is either backed up or listed here as deliberately
 * left out. A new table added later fails this test until someone decides
 * which it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const tablesIn = (sql) => [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)].map(m => m[1]);

// Left out of the server backup on purpose, with the reason.
const SERVER_SKIP = {
  oauth_state: 'a sign-in in flight, worthless minutes later',
  password_reset_tokens: 'single use, expire quickly',
  notification_log: 'restoring it would re-fire or silence notifications',
  link_previews: 'a cache that refills itself',
};
// Left out of the Android local backup on purpose.
const LOCAL_SKIP = {
  sync_log: 'what this device still owes the server',
  sync_meta: 'this device\'s sync bookkeeping',
};

test('the server backup covers every table it should', () => {
  const schema = read('server/db.js');
  const backup = read('server/routes/full-backup.js');
  const dumped = new Set([...backup.matchAll(/^\s*([a-z_]+):\s+(?:db\.prepare\('SELECT \* FROM |_selectIfExists\(')/gm)].map(m => m[1]));
  for (const t of new Set(tablesIn(schema))) {
    if (SERVER_SKIP[t]) {
      assert.ok(!dumped.has(t), `${t} is in the backup but listed as skipped (${SERVER_SKIP[t]})`);
      continue;
    }
    assert.ok(dumped.has(t), `${t} is in the database but not in the backup. Add it to dumpDatabase() and restoreFromZip(), or to SERVER_SKIP with a reason.`);
  }
});

test('the server backup restores everything it saves', () => {
  const backup = read('server/routes/full-backup.js');
  const dumped = [...backup.matchAll(/^\s*([a-z_]+):\s+(?:db\.prepare\('SELECT \* FROM |_selectIfExists\(')/gm)].map(m => m[1]);
  const restored = backup.slice(backup.indexOf('function restoreFromZip'));
  for (const t of dumped) {
    assert.ok(new RegExp(`['\`(]${t}[',\`)]|INTO ${t} `).test(restored), `${t} is saved in the backup but never restored`);
  }
});

test('the Android local backup covers every local table', () => {
  const schema = read('src/lib/db-native.js');
  const tables = new Set(tablesIn(schema));
  assert.ok(tables.size >= 8, 'found the local schema');
  const list = read('src/lib/local-backup.js').match(/const TABLES = \[([^\]]+)\]/)[1];
  const covered = new Set([...list.matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
  for (const t of tables) {
    if (LOCAL_SKIP[t]) {
      assert.ok(!covered.has(t), `${t} is in the local backup but listed as skipped (${LOCAL_SKIP[t]})`);
      continue;
    }
    assert.ok(covered.has(t), `${t} is in the local database but not in the local backup. Add it to TABLES in src/lib/local-backup.js, or to LOCAL_SKIP with a reason.`);
  }
});

test('a portable export carries the notes and everything on them', () => {
  const data = read('server/routes/data.js');
  for (const t of ['notes', 'labels', 'checklist_items', 'note_labels', 'note_attachments', 'user_settings', 'ai_chat_history', 'note_versions']) {
    assert.ok(data.includes(`'${t}'`) || data.includes(`out.${t}`), `${t} is missing from the portable export`);
  }
});
