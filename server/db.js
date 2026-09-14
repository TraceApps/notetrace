import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DB_PATH || './notetrace.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Core tables ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    full_name     TEXT,
    nickname      TEXT,
    birthday      TEXT,
    gender        TEXT,
    avatar_url    TEXT,
    role          TEXT NOT NULL DEFAULT 'user',
    email         TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT DEFAULT NULL,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used       INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS invite_tokens (
    token      TEXT PRIMARY KEY,
    email      TEXT,
    role       TEXT NOT NULL DEFAULT 'user',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    used       INTEGER DEFAULT 0
  );

  -- Personal access tokens. Currently the auth mechanism for the MCP
  -- endpoint (/api/mcp); a general-purpose token store so a future
  -- federation-style API can reuse it without a schema change. Raw
  -- token value is never stored, only its SHA-256 hash.
  CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    scopes       TEXT NOT NULL DEFAULT '[]',  -- JSON array of scope strings
    expires_at   TEXT,                         -- NULL = never expires
    last_used_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

  -- Outgoing webhooks. secret_encrypted is AES-256-GCM (token-crypto.js),
  -- not hashed like api_tokens.token_hash, because the server needs the
  -- plaintext back later to compute each delivery's HMAC.
  CREATE TABLE IF NOT EXISTS webhooks (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url                  TEXT NOT NULL,
    secret_encrypted     TEXT NOT NULL,
    events               TEXT NOT NULL DEFAULT '[]',  -- JSON array of event names
    enabled              INTEGER NOT NULL DEFAULT 1,
    last_delivery_at     TEXT,
    last_delivery_status TEXT,                        -- 'success' | 'failed' | NULL
    last_delivery_error  TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);
`);

// ── AI assistant chat history (per user) ───────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_chat_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_chat_history_user ON ai_chat_history(user_id, created_at);
`);

// ── OIDC / SSO ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_state (
    state       TEXT PRIMARY KEY,
    user_id     INTEGER,
    provider    TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}',
    expires_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oidc_providers (
    id                            INTEGER PRIMARY KEY AUTOINCREMENT,
    issuer_url                    TEXT NOT NULL,
    client_id                     TEXT NOT NULL,
    client_secret                 TEXT,
    redirect_uris                 TEXT NOT NULL DEFAULT '[]',
    scope                         TEXT NOT NULL DEFAULT 'openid profile email',
    token_endpoint_auth_method    TEXT NOT NULL DEFAULT 'client_secret_post',
    response_types                TEXT NOT NULL DEFAULT '["code"]',
    id_token_signed_response_alg  TEXT NOT NULL DEFAULT 'RS256',
    userinfo_signed_response_alg  TEXT NOT NULL DEFAULT 'none',
    request_timeout_ms            INTEGER NOT NULL DEFAULT 30000,
    auto_register                 INTEGER NOT NULL DEFAULT 0,
    auto_link_verified_email      INTEGER NOT NULL DEFAULT 1,
    auto_register_new_users       INTEGER NOT NULL DEFAULT 0,
    admin_group_claim             TEXT,
    admin_group_value             TEXT,
    display_name                  TEXT,
    logo_url                      TEXT,
    is_active                     INTEGER NOT NULL DEFAULT 1,
    created_at                    TEXT DEFAULT (datetime('now')),
    updated_at                    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_oidc_links (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    oidc_provider_id  INTEGER NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
    oidc_sub          TEXT NOT NULL,
    email_verified    INTEGER DEFAULT 0,
    last_login_at     TEXT,
    created_at        TEXT DEFAULT (datetime('now')),
    UNIQUE (oidc_provider_id, oidc_sub)
  );
  CREATE INDEX IF NOT EXISTS idx_user_oidc_links_user ON user_oidc_links(user_id);
`);

// ── Notes ──────────────────────────────────────────────────────────────────
// body_md is the source of truth (the editor stores Markdown). kind is
// 'text' or 'checklist'. trashed_at marks a user-visible trash entry
// (purged after 30 days); deleted_at is the sync tombstone.
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
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
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now')),
    deleted_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_notes_user    ON notes(user_id);
  CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
  CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted_at);

  -- One row per checklist item. uuid is client-generated and stable
  -- across devices. Items are never replaced as a list: every add,
  -- edit, check, reorder and delete touches only its own row, and a
  -- delete is a deleted_at tombstone, so a device holding a stale copy
  -- of the list can't wipe items another device added.
  CREATE TABLE IF NOT EXISTS checklist_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid       TEXT NOT NULL UNIQUE,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    text       TEXT NOT NULL DEFAULT '',
    checked    INTEGER NOT NULL DEFAULT 0,
    position   REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_items_note    ON checklist_items(note_id);
  CREATE INDEX IF NOT EXISTS idx_items_user    ON checklist_items(user_id);
  CREATE INDEX IF NOT EXISTS idx_items_updated ON checklist_items(updated_at);

  CREATE TABLE IF NOT EXISTS labels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_labels_user    ON labels(user_id);
  CREATE INDEX IF NOT EXISTS idx_labels_updated ON labels(updated_at);

  -- Removing a label from a note soft-deletes the link row so the
  -- removal syncs; re-adding it revives the same row.
  CREATE TABLE IF NOT EXISTS note_labels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    label_id   INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    UNIQUE (note_id, label_id)
  );
  CREATE INDEX IF NOT EXISTS idx_note_labels_label   ON note_labels(label_id);
  CREATE INDEX IF NOT EXISTS idx_note_labels_updated ON note_labels(updated_at);

  -- Snapshots of a note's earlier content. Written at edit-session
  -- boundaries and whenever sync resolves a conflict, so no edit is ever
  -- silently lost. Server-side only; not part of the sync payload.
  CREATE TABLE IF NOT EXISTS note_versions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT '',
    body_md    TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT 'text',
    items_json TEXT,
    reason     TEXT NOT NULL DEFAULT 'edit',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id, created_at);

  -- People a note is shared with. The note row stays with its owner;
  -- members get 'view' or 'edit' on its content and checklist. Pin and
  -- archive are personal, so they live here for members. A removed
  -- member keeps a tombstone (deleted_at) so their devices learn to drop
  -- the note on the next sync. updated_at is always server-stamped.
  CREATE TABLE IF NOT EXISTS note_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'edit',
    pinned     INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    added_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    deleted_at TEXT,
    UNIQUE (note_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_note_members_user ON note_members(user_id, deleted_at);

  -- Images on a note, shown above its text or checklist. Like checklist
  -- items: a stable client uuid, the note owner's user_id whoever adds it,
  -- and a deleted_at tombstone so removals sync. url is an /uploads/ path.
  CREATE TABLE IF NOT EXISTS note_attachments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid       TEXT NOT NULL UNIQUE,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    url        TEXT NOT NULL DEFAULT '',
    mime       TEXT,
    width      INTEGER,
    height     INTEGER,
    position   REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_note ON note_attachments(note_id);
`);

// ── Full-text search ───────────────────────────────────────────────────────
// Contentless-style FTS5 index keyed by note rowid, rebuilt per note by
// triggers on notes and checklist_items. Triggers (not route code) keep
// the index right for every write path: REST routes, sync push, restore.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title, body, items, tokenize = 'unicode61 remove_diacritics 2'
  );
`);
{
  const refresh = (noteIdExpr) => `
    DELETE FROM notes_fts WHERE rowid = ${noteIdExpr};
    INSERT INTO notes_fts (rowid, title, body, items)
      SELECT n.id, n.title, n.body_md,
             COALESCE((SELECT group_concat(ci.text, ' ') FROM checklist_items ci
                        WHERE ci.note_id = n.id AND ci.deleted_at IS NULL), '')
        FROM notes n WHERE n.id = ${noteIdExpr} AND n.deleted_at IS NULL;`;
  db.exec(`
    DROP TRIGGER IF EXISTS trg_notes_fts_upd;
    DROP TRIGGER IF EXISTS trg_items_fts_upd;
    CREATE TRIGGER IF NOT EXISTS trg_notes_fts_ins AFTER INSERT ON notes BEGIN ${refresh('NEW.id')} END;
    CREATE TRIGGER IF NOT EXISTS trg_notes_fts_upd AFTER UPDATE OF title, body_md, deleted_at ON notes BEGIN ${refresh('NEW.id')} END;
    CREATE TRIGGER IF NOT EXISTS trg_notes_fts_del AFTER DELETE ON notes BEGIN DELETE FROM notes_fts WHERE rowid = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_items_fts_ins AFTER INSERT ON checklist_items BEGIN ${refresh('NEW.note_id')} END;
    CREATE TRIGGER IF NOT EXISTS trg_items_fts_upd AFTER UPDATE OF text, note_id, deleted_at ON checklist_items BEGIN ${refresh('NEW.note_id')} END;
    CREATE TRIGGER IF NOT EXISTS trg_items_fts_del AFTER DELETE ON checklist_items BEGIN ${refresh('OLD.note_id')} END;
  `);
}

// ── Migrations ─────────────────────────────────────────────────────────────
// Idempotent: each block adds a column only if it doesn't already exist.
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);
}

// Reminder repeats are evaluated in the timezone the reminder was set in,
// so "daily at 8:00" stays at 8:00 across daylight-saving changes.
if (!columnExists('notes', 'reminder_tz')) db.exec(`ALTER TABLE notes ADD COLUMN reminder_tz TEXT`);

// /api/sync/pull SELECTs updated_at on every synced table, including
// ai_chat_history. SQLite refuses non-constant DEFAULTs on ALTER ADD
// COLUMN, so older databases get the column without a default and a pair
// of triggers keeps it populated.
if (!columnExists('ai_chat_history', 'updated_at')) {
  db.exec(`ALTER TABLE ai_chat_history ADD COLUMN updated_at TEXT`);
  db.exec(`UPDATE ai_chat_history SET updated_at = created_at WHERE updated_at IS NULL`);
}
db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_ai_chat_history_updated_at_ins
  AFTER INSERT ON ai_chat_history
  FOR EACH ROW WHEN NEW.updated_at IS NULL
  BEGIN
    UPDATE ai_chat_history SET updated_at = datetime('now') WHERE id = NEW.id;
  END;
`);
db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_ai_chat_history_updated_at_upd
  AFTER UPDATE ON ai_chat_history
  FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
  BEGIN
    UPDATE ai_chat_history SET updated_at = datetime('now') WHERE id = NEW.id;
  END;
`);

// ── Sync cursor ────────────────────────────────────────────────────────────
// synced_at is the SERVER's clock time of the last write to a row, stamped
// by triggers so every write path (REST routes, sync push, restore) is
// covered. /api/sync/pull filters on it. updated_at can't serve as the
// pull cursor: a device stamps updated_at when the user edits, which may
// be long before the edit reaches the server, so an offline edit could
// land behind another device's last pull and never be sent to it.
{
  const STAMP = `strftime('%Y-%m-%d %H:%M:%f', 'now')`;
  for (const t of ['notes', 'labels', 'checklist_items', 'note_labels', 'note_attachments', 'ai_chat_history']) {
    if (!columnExists(t, 'synced_at')) db.exec(`ALTER TABLE ${t} ADD COLUMN synced_at TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_synced ON ${t}(synced_at)`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${t}_synced_ins AFTER INSERT ON ${t}
      BEGIN UPDATE ${t} SET synced_at = ${STAMP} WHERE id = NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS trg_${t}_synced_upd AFTER UPDATE ON ${t}
      BEGIN UPDATE ${t} SET synced_at = ${STAMP} WHERE id = NEW.id; END;
    `);
  }
  if (!columnExists('user_settings', 'synced_at')) db.exec(`ALTER TABLE user_settings ADD COLUMN synced_at TEXT`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_user_settings_synced_ins AFTER INSERT ON user_settings
    BEGIN UPDATE user_settings SET synced_at = ${STAMP} WHERE user_id IS NEW.user_id AND key = NEW.key; END;
    CREATE TRIGGER IF NOT EXISTS trg_user_settings_synced_upd AFTER UPDATE ON user_settings
    BEGIN UPDATE user_settings SET synced_at = ${STAMP} WHERE user_id IS NEW.user_id AND key = NEW.key; END;
  `);
}

// ── Notification de-dupe log ───────────────────────────────────────────────
// Records every notification the scheduler has fired so the next tick
// doesn't double-send. (kind, ref_id, fired_date) is the dedup key.
db.exec(`
  CREATE TABLE IF NOT EXISTS notification_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    ref_id      INTEGER,
    fired_date  TEXT NOT NULL,
    fired_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notif_log_user ON notification_log(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_log_dedup ON notification_log(user_id, kind, ref_id, fired_date);
`);

// ── Seed default app_config rows ───────────────────────────────────────────
{
  const seeds = [
    ['enable_email_password_login', '1'],
  ];
  const ins = db.prepare(`INSERT OR IGNORE INTO app_config (key, value) VALUES (?, ?)`);
  for (const [k, v] of seeds) ins.run(k, v);
}

export default db;
