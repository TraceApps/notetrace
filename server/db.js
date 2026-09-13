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
// Phase 0 shape: enough for sync, backup, and single-user claim to have a
// real domain table to work against. Checklist items, labels, members,
// versions, attachments and links arrive with the notes data layer.
//
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
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now')),
    deleted_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_notes_user    ON notes(user_id);
  CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
  CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted_at);
`);

// ── Migrations ─────────────────────────────────────────────────────────────
// Idempotent: each block adds a column only if it doesn't already exist.
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);
}

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
