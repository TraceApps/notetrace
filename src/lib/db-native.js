/**
 * db-native.js — SQLite database layer for the Capacitor native app.
 *
 * Uses @capacitor-community/sqlite to provide a local SQLite database that
 * mirrors the NoteTrace server schema. All data in standalone (local-only)
 * mode lives here. In server-connected mode the same DB acts as an
 * offline-first cache that the differential sync engine reconciles with
 * the configured server.
 *
 * The local user_id is always 1 (single-user standalone semantics). When
 * connecting to a server the user_id stays 1 locally; the sync layer maps
 * to whatever user the auth token resolves to on the server side.
 *
 * Same SQLiteConnection setup, SCHEMA constant approach, and
 * sync_status / server_id columns on every syncable table as the other
 * TraceApps.
 */

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { isNative } from './platform.js';

export const LOCAL_USER_ID = 1;
const DB_NAME = 'notetrace_local';
const DB_VERSION = 1;

const sqlite = new SQLiteConnection(CapacitorSQLite);
let _db = null;
let _initPromise = null;

// ── Schema ────────────────────────────────────────────────────────────
// Mirrors server/db.js with every ALTER baked into the CREATE so a
// fresh local DB lands at the same shape the live server would land at
// after every migration ran. Adds server_id + sync_status columns on
// every syncable table so the differential sync engine knows which
// rows are dirty and where they map to upstream.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id      INTEGER,
    user_id        INTEGER DEFAULT 1,
    title          TEXT NOT NULL DEFAULT '',
    body_md        TEXT NOT NULL DEFAULT '',
    kind           TEXT NOT NULL DEFAULT 'text',
    color          TEXT,
    pinned         INTEGER NOT NULL DEFAULT 0,
    archived       INTEGER NOT NULL DEFAULT 0,
    trashed_at     TEXT,
    reminder_at    TEXT,
    reminder_rrule TEXT,
    reminder_tz    TEXT,
    share_role     TEXT DEFAULT 'owner',
    share_owner    TEXT,
    share_count    INTEGER DEFAULT 0,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now')),
    deleted_at     TEXT DEFAULT NULL,
    sync_status    TEXT DEFAULT 'synced'
  );
  CREATE INDEX IF NOT EXISTS idx_notes_user    ON notes(user_id);
  CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
  CREATE INDEX IF NOT EXISTS idx_notes_server  ON notes(server_id);
  CREATE INDEX IF NOT EXISTS idx_notes_sync    ON notes(sync_status);

  CREATE TABLE IF NOT EXISTS checklist_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER,
    uuid        TEXT NOT NULL UNIQUE,
    user_id     INTEGER DEFAULT 1,
    note_id     INTEGER NOT NULL,
    text        TEXT NOT NULL DEFAULT '',
    checked     INTEGER NOT NULL DEFAULT 0,
    position    REAL NOT NULL DEFAULT 0,
    due_date    TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    deleted_at  TEXT DEFAULT NULL,
    sync_status TEXT DEFAULT 'synced'
  );
  CREATE INDEX IF NOT EXISTS idx_items_note   ON checklist_items(note_id);
  CREATE INDEX IF NOT EXISTS idx_items_server ON checklist_items(server_id);
  CREATE INDEX IF NOT EXISTS idx_items_sync   ON checklist_items(sync_status);

  CREATE TABLE IF NOT EXISTS note_attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER,
    uuid        TEXT NOT NULL UNIQUE,
    user_id     INTEGER DEFAULT 1,
    note_id     INTEGER NOT NULL,
    url         TEXT NOT NULL DEFAULT '',
    mime        TEXT,
    width       INTEGER,
    height      INTEGER,
    position    REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    extracted_text TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    deleted_at  TEXT DEFAULT NULL,
    sync_status TEXT DEFAULT 'synced'
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_note   ON note_attachments(note_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_server ON note_attachments(server_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_sync   ON note_attachments(sync_status);

  CREATE TABLE IF NOT EXISTS labels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER,
    user_id     INTEGER DEFAULT 1,
    name        TEXT NOT NULL,
    color       TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    deleted_at  TEXT DEFAULT NULL,
    sync_status TEXT DEFAULT 'synced'
  );
  CREATE INDEX IF NOT EXISTS idx_labels_server ON labels(server_id);
  CREATE INDEX IF NOT EXISTS idx_labels_sync   ON labels(sync_status);

  CREATE TABLE IF NOT EXISTS note_labels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER,
    user_id     INTEGER DEFAULT 1,
    note_id     INTEGER NOT NULL,
    label_id    INTEGER NOT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    deleted_at  TEXT DEFAULT NULL,
    sync_status TEXT DEFAULT 'synced',
    UNIQUE (note_id, label_id)
  );
  CREATE INDEX IF NOT EXISTS idx_note_labels_server ON note_labels(server_id);
  CREATE INDEX IF NOT EXISTS idx_note_labels_sync   ON note_labels(sync_status);

  -- Local restore points for this device. Not synced; the server keeps
  -- its own history, including conflict copies.
  CREATE TABLE IF NOT EXISTS note_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id     INTEGER NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    body_md     TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT 'text',
    items_json  TEXT,
    reason      TEXT NOT NULL DEFAULT 'edit',
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id, created_at);

  -- Settings table — every change writes here first (sync_status='pending'),
  -- the sync engine pushes pending rows to the server, server pull marks
  -- them 'synced' on success. PWA never touches this table.
  CREATE TABLE IF NOT EXISTS user_settings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER DEFAULT 1,
    key         TEXT NOT NULL,
    value       TEXT,
    updated_at  TEXT DEFAULT (datetime('now')),
    deleted_at  TEXT DEFAULT NULL,
    sync_status TEXT DEFAULT 'synced',
    UNIQUE(user_id, key)
  );

  CREATE TABLE IF NOT EXISTS ai_chat_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER,
    user_id     INTEGER DEFAULT 1,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    sync_status TEXT DEFAULT 'synced'
  );
  CREATE INDEX IF NOT EXISTS idx_chat_user ON ai_chat_history(user_id, created_at);

  -- Sync infrastructure tables — not mirrored on the server side.
  CREATE TABLE IF NOT EXISTS sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at   TEXT DEFAULT (datetime('now')),
    direction   TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    record_id   INTEGER,
    status      TEXT NOT NULL DEFAULT 'ok',
    error       TEXT
  );
`;

// ── Initialisation ────────────────────────────────────────────────────
// Lazy on first use. Subsequent callers await the same promise so
// concurrent first-call requests don't race the connection setup.
//
// The plugin's `isConnection` check drifts from internal state on app
// reload (the JS side restarts but the plugin remembers the old
// connection). Don't trust it — always close any leftover connection
// first, then create fresh. Pattern lifted from NutriTrace's db-native
// after the same bug burned us there.
async function _closeAny() {
  await sqlite.checkConnectionsConsistency().catch(() => {});
  try { await sqlite.closeConnection(DB_NAME, true);  } catch {}
  try { await sqlite.closeConnection(DB_NAME, false); } catch {}
}

export async function getDb() {
  if (_db) return _db;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    if (!isNative) {
      throw new Error('db-native is only available in the Capacitor native shell');
    }
    await _closeAny();
    const conn = await sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);
    await conn.open();
    await conn.execute(SCHEMA);
    _db = conn;
    return _db;
  })().catch(err => {
    // Reset so a retry from the catch path in main.js (or a later
    // explicit dbInit() call) doesn't get stuck on the failed promise.
    _initPromise = null;
    throw err;
  });
  return _initPromise;
}

/**
 * Boot hook. Called from main.js on native; no-op on web. Safe to call
 * multiple times; the underlying getDb() memoises.
 */
export async function dbInit() {
  if (!isNative) return;
  await getDb();
  await _migrateAiChatUpdatedAt();
  await _migrateShareColumns();
}

// Share fields came with note sharing; older installs add them here.
// Server-managed: filled by pulls, never pushed.
async function _migrateShareColumns() {
  try {
    const db = await getDb();
    const info = await db.query(`PRAGMA table_info(notes)`);
    const have = new Set((info?.values || []).map(c => c.name));
    if (!have.has('share_role')) await db.run(`ALTER TABLE notes ADD COLUMN share_role TEXT DEFAULT 'owner'`);
    if (!have.has('share_owner')) await db.run(`ALTER TABLE notes ADD COLUMN share_owner TEXT`);
    if (!have.has('share_count')) await db.run(`ALTER TABLE notes ADD COLUMN share_count INTEGER DEFAULT 0`);
    const att = await db.query(`PRAGMA table_info(note_attachments)`);
    const attCols = new Set((att?.values || []).map(c => c.name));
    if (attCols.size && !attCols.has('duration_ms')) await db.run(`ALTER TABLE note_attachments ADD COLUMN duration_ms INTEGER`);
    if (attCols.size && !attCols.has('extracted_text')) await db.run(`ALTER TABLE note_attachments ADD COLUMN extracted_text TEXT`);
    const itemInfo = await db.query(`PRAGMA table_info(checklist_items)`);
    const itemCols = new Set((itemInfo?.values || []).map(c => c.name));
    if (itemCols.size && !itemCols.has('due_date')) await db.run(`ALTER TABLE checklist_items ADD COLUMN due_date TEXT`);
  } catch { /* best-effort */ }
}

// Some SQLite versions refuse non-constant DEFAULTs on ALTER ADD
// COLUMN (the Node.js binding in the Docker image crashed on
// DEFAULT (datetime('now'))). Use the same trigger pattern as the
// server — ALTER without default, backfill, then AFTER INSERT /
// AFTER UPDATE triggers populate updated_at automatically.
async function _migrateAiChatUpdatedAt() {
  try {
    const db = await getDb();
    const info = await db.query(`PRAGMA table_info(ai_chat_history)`);
    const has = (info?.values || []).some(c => c.name === 'updated_at');
    if (!has) {
      await db.run(`ALTER TABLE ai_chat_history ADD COLUMN updated_at TEXT`);
      await db.run(`UPDATE ai_chat_history SET updated_at = created_at WHERE updated_at IS NULL`);
    }
    await db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_ai_chat_history_updated_at_ins
      AFTER INSERT ON ai_chat_history
      FOR EACH ROW WHEN NEW.updated_at IS NULL
      BEGIN
        UPDATE ai_chat_history SET updated_at = datetime('now') WHERE id = NEW.id;
      END;
    `);
    await db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_ai_chat_history_updated_at_upd
      AFTER UPDATE ON ai_chat_history
      FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
      BEGIN
        UPDATE ai_chat_history SET updated_at = datetime('now') WHERE id = NEW.id;
      END;
    `);
  } catch { /* best-effort */ }
}

// ── Settings sync helpers ─────────────────────────────────────────────
// These existed as no-ops in the Phase A stub — we kept their shape so
// the JS layer (stores/settings.js) can call them without branching on
// `isNative`. Now they actually persist to the local user_settings
// table when running native.

export async function dbUpsertSetting(key, value) {
  if (!isNative) return;
  const db = await getDb();
  const v = value == null ? null : String(value);
  await db.run(
    `INSERT INTO user_settings (user_id, key, value, sync_status)
     VALUES (?, ?, ?, 'pending')
     ON CONFLICT(user_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = datetime('now'),
       sync_status = 'pending'`,
    [LOCAL_USER_ID, key, v]
  );
}

/**
 * Mark settings as synced AFTER a successful push, gated on updated_at
 * matching the snapshot. Closes a mid-flight write race: if the user
 * edited the same setting between the push snapshot and the push
 * response, the row's updated_at moved forward and the WHERE clause
 * won't match — the row stays pending and the next sync re-pushes the
 * fresh value. See NT commit b364c24 for the full race description.
 *
 * `rows` is an array of `{key, updated_at}` taken from the push snapshot.
 */
export async function dbMarkSettingsSynced(rows) {
  if (!isNative || !rows || rows.length === 0) return;
  const db = await getDb();
  for (const r of rows) {
    await db.run(
      `UPDATE user_settings SET sync_status = 'synced'
       WHERE user_id = ? AND key = ? AND updated_at = ?`,
      [LOCAL_USER_ID, r.key, r.updated_at]
    );
  }
}

export async function dbGetAllSettings() {
  if (!isNative) return {};
  const db = await getDb();
  const res = await db.query(
    `SELECT key, value FROM user_settings WHERE user_id = ? AND deleted_at IS NULL`,
    [LOCAL_USER_ID]
  );
  const out = {};
  for (const row of res?.values || []) out[row.key] = row.value;
  return out;
}

export async function dbGetPendingSettings() {
  if (!isNative) return [];
  const db = await getDb();
  const res = await db.query(
    `SELECT key, value FROM user_settings
      WHERE user_id = ? AND deleted_at IS NULL AND sync_status = 'pending'`,
    [LOCAL_USER_ID]
  );
  return res?.values || [];
}

// ── sync_meta helpers ─────────────────────────────────────────────────
// Used by platform.js (image_map cache) and the sync engine (last_pull
// timestamp). String-only — JSON callers stringify/parse themselves.

export async function dbGetMeta(key) {
  if (!isNative) return null;
  const db = await getDb();
  const res = await db.query(`SELECT value FROM sync_meta WHERE key = ?`, [key]);
  return res?.values?.[0]?.value ?? null;
}

export async function dbSetMeta(key, value) {
  if (!isNative) return;
  const db = await getDb();
  await db.run(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value == null ? null : String(value)]
  );
}

// ── Sync helpers ──────────────────────────────────────────────────────
// Used by src/lib/sync.js to drive differential push/pull against
// /api/sync/{push,pull}. Each syncable table contributes pending rows;
// pulled rows are upserted by server_id with FK translation via the
// local server_id index on parent tables.

// Tables sync.js pushes. Keep in dependency order so server-side FK
// translation has parent ids minted by the time children push.
const SYNC_TABLES = ['notes', 'labels', 'checklist_items', 'note_attachments', 'note_labels', 'ai_chat_history'];

// FK columns on synced child tables, and the parent table each points at.
// Local rows hold local ids; sync.js translates them to server ids on push
// and dbApplyPull translates server ids back to local ids on pull.
export const SYNC_PARENTS = {
  checklist_items: { note_id: 'notes' },
  note_attachments: { note_id: 'notes' },
  note_labels: { note_id: 'notes', label_id: 'labels' },
};

// Natural keys used to match a pulled row to a local row that hasn't
// received its server_id yet (created here, not pushed before the pull).
const SYNC_UNIQUE_KEYS = {
  checklist_items: ['uuid'],
  note_attachments: ['uuid'],
  note_labels: ['note_id', 'label_id'],
};

/** All rows with sync_status='pending' grouped by table. */
export async function dbGetPendingChanges() {
  if (!isNative) return {};
  const db = await getDb();
  const out = {};
  for (const table of SYNC_TABLES) {
    const r = await db.query(
      `SELECT * FROM ${table} WHERE user_id = ? AND sync_status = 'pending'`,
      [LOCAL_USER_ID]
    );
    out[table] = r?.values || [];
  }
  return out;
}

/** Settings rows with sync_status='pending'. Separate because the sync
 *  endpoint takes a `settings` array, not a generic table. */
export async function dbGetPendingSettingsForPush() {
  if (!isNative) return [];
  const db = await getDb();
  const r = await db.query(
    `SELECT key, value, updated_at FROM user_settings
      WHERE user_id = ? AND deleted_at IS NULL AND sync_status = 'pending'`,
    [LOCAL_USER_ID]
  );
  return r?.values || [];
}

/**
 * Stamp the server_id on a freshly-pushed row and mark it synced.
 * Gated on updated_at matching the push snapshot so mid-flight edits
 * stay pending and get re-pushed next sync. See dbMarkSettingsSynced
 * for the full race description. If snapshotUpdatedAt is null (caller
 * didn't capture one), falls back to the old behaviour of stamping
 * unconditionally — but that path is unsafe and should be removed once
 * every caller is updated to pass the snapshot.
 */
export async function dbSetServerId(table, clientId, serverId, snapshotUpdatedAt = null) {
  if (!isNative || !table || !clientId) return;
  const db = await getDb();
  if (snapshotUpdatedAt) {
    await db.run(
      `UPDATE ${table} SET server_id = ?, sync_status = 'synced' WHERE id = ? AND updated_at = ?`,
      [serverId, clientId, snapshotUpdatedAt]
    );
    // If the row was edited mid-flight, the WHERE didn't match. Still stamp
    // the server_id (caller needs it for future PATCH/PUT routing), but
    // leave sync_status='pending' so the next push picks up the fresh value.
    await db.run(
      `UPDATE ${table} SET server_id = ? WHERE id = ? AND server_id IS NULL`,
      [serverId, clientId]
    );
  } else {
    await db.run(
      `UPDATE ${table} SET server_id = ?, sync_status = 'synced' WHERE id = ?`,
      [serverId, clientId]
    );
  }
}

/** Apply pulled rows from /api/sync/pull. For each table, upsert by
 *  server_id. Parent-table FK columns are translated from server ids to local ids via the per-table
 *  server_id index.
 */
export async function dbApplyPull(payload) {
  if (!isNative || !payload?.tables) return;
  const db = await getDb();
  // FK column -> candidate parent tables, used to translate server ids
  // to local ids.
  const parents = { note_id: ['notes'], label_id: ['labels'] };

  // Build a per-table { server_id → local_id } map by scanning the
  // local server_id column once. Re-scanned per pull so it picks up
  // ids minted by parent-table upserts earlier in the same pull.
  async function mapFor(table) {
    const r = await db.query(`SELECT id, server_id FROM ${table} WHERE server_id IS NOT NULL`, []);
    const m = new Map();
    for (const row of r?.values || []) m.set(row.server_id, row.id);
    return m;
  }

  async function translateFK(value, candidates) {
    if (value == null) return null;
    for (const t of candidates) {
      const m = await mapFor(t);
      if (m.has(value)) return m.get(value);
    }
    return null;
  }

  for (const [table, rows] of Object.entries(payload.tables)) {
    if (!Array.isArray(rows)) continue;
    if (table === 'settings') continue;

    for (const row of rows) {
      let existing = (await db.query(
        `SELECT id, sync_status FROM ${table} WHERE server_id = ? LIMIT 1`,
        [row.id]
      ))?.values?.[0];

      // Translate FK columns from server ids to local ids.
      const translated = { ...row };
      let unresolved = false;
      for (const [fk, candidates] of Object.entries(parents)) {
        if (fk in translated && translated[fk] != null) {
          translated[fk] = await translateFK(translated[fk], candidates);
          if (translated[fk] == null && SYNC_PARENTS[table]?.[fk]) unresolved = true;
        }
      }
      // A child whose parent isn't here (e.g. a tombstoned note that was
      // never pulled) has nothing to attach to.
      if (unresolved) continue;

      // Not known by server_id: match a local row created on this device
      // that shares the natural key, and adopt the server id.
      if (!existing && SYNC_UNIQUE_KEYS[table]) {
        const keys = SYNC_UNIQUE_KEYS[table];
        existing = (await db.query(
          `SELECT id, sync_status FROM ${table} WHERE ${keys.map(k => `${k} = ?`).join(' AND ')} LIMIT 1`,
          keys.map(k => translated[k])
        ))?.values?.[0];
        if (existing) await db.run(`UPDATE ${table} SET server_id = ? WHERE id = ?`, [row.id, existing.id]);
      }

      // Local pending edits shouldn't be overwritten by the server's
      // pre-edit snapshot for user-editable columns. STRUCTURAL FK
      // columns are managed by explicit attach/detach flows, not
      // free-text editing, so those still apply from the pull even when
      // the row is pending.
      if (existing && existing.sync_status === 'pending') {
        const fkKeys = Object.keys(parents).filter(k => k in translated);
        if (fkKeys.length) {
          const setClause = fkKeys.map(k => `${k} = ?`).join(', ');
          const setValues = fkKeys.map(k => translated[k]);
          await db.run(
            `UPDATE ${table} SET ${setClause} WHERE id = ?`,
            [...setValues, existing.id]
          );
        }
        continue;
      }

      // Build column list dynamically from the row's keys (minus `id`).
      const cols = Object.keys(translated).filter(k => k !== 'id');
      const values = cols.map(k => {
        const v = translated[k];
        if (v == null) return null;
        if (typeof v === 'object') return JSON.stringify(v);
        return v;
      });

      if (existing) {
        const set = cols.map(c => `${c} = ?`).join(', ');
        await db.run(
          `UPDATE ${table} SET ${set}, sync_status = 'synced' WHERE id = ?`,
          [...values, existing.id]
        );
      } else {
        await db.run(
          `INSERT INTO ${table} (server_id, user_id, ${cols.join(', ')}, sync_status)
           VALUES (?, ?, ${cols.map(() => '?').join(', ')}, 'synced')`,
          [row.id, LOCAL_USER_ID, ...values]
        );
      }
    }
  }

  // Shared notes this account can no longer see (removed, left, or the
  // owner trashed or deleted them): drop the local copy and its rows.
  if (Array.isArray(payload.revoked_notes)) {
    for (const serverId of payload.revoked_notes) {
      const local = (await db.query(`SELECT id FROM notes WHERE server_id = ?`, [serverId]))?.values?.[0];
      if (!local) continue;
      await db.run(`DELETE FROM checklist_items WHERE note_id = ?`, [local.id]);
      await db.run(`DELETE FROM note_attachments WHERE note_id = ?`, [local.id]);
      await db.run(`DELETE FROM note_labels WHERE note_id = ?`, [local.id]);
      await db.run(`DELETE FROM note_versions WHERE note_id = ?`, [local.id]);
      await db.run(`DELETE FROM notes WHERE id = ?`, [local.id]);
    }
  }

  // Settings: write each key into the local user_settings table as
  // 'synced' so the user can see the pulled value without it bouncing
  // back into the next push. Skip keys the user has a local pending
  // edit for — the pull would otherwise clobber the fresh value with
  // the server's pre-edit copy, same shape as the per-table guard above.
  if (Array.isArray(payload.tables.settings)) {
    for (const s of payload.tables.settings) {
      const localRow = (await db.query(
        `SELECT sync_status FROM user_settings WHERE user_id = ? AND key = ? LIMIT 1`,
        [LOCAL_USER_ID, s.key]
      ))?.values?.[0];
      if (localRow?.sync_status === 'pending') continue;

      const v = typeof s.value === 'string' ? s.value : (s.value == null ? null : JSON.stringify(s.value));
      await db.run(
        `INSERT INTO user_settings (user_id, key, value, updated_at, sync_status)
         VALUES (?, ?, ?, ?, 'synced')
         ON CONFLICT(user_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           sync_status = 'synced'`,
        [LOCAL_USER_ID, s.key, v, s.updated_at || new Date().toISOString()]
      );
    }
  }
}

/**
 * Bulk-mark rows in a table 'synced' after a successful push. Gated on
 * updated_at matching the snapshot. `rows` is an array of `{id,
 * updated_at}` taken from the push snapshot. See dbMarkSettingsSynced
 * for the full race description.
 */
export async function dbMarkTableSynced(table, rows) {
  if (!isNative || !rows || !rows.length) return;
  const db = await getDb();
  for (const r of rows) {
    await db.run(
      `UPDATE ${table} SET sync_status = 'synced' WHERE id = ? AND updated_at = ?`,
      [r.id, r.updated_at]
    );
  }
}
