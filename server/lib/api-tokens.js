/**
 * server/lib/api-tokens.js
 *
 * Personal access token management. Currently the sole consumer is the
 * MCP endpoint (/api/mcp) — tokens are SHA-256 hashed at rest. Raw
 * values are returned to the caller exactly once at creation; lookup
 * is hash-based.
 *
 * Token format: `note_pat_<43 base64url chars>`. The `note_pat_` prefix
 * makes leaked tokens recognizable in logs and credential scanners.
 */
import { randomBytes, createHash } from 'crypto';
import db from '../db.js';

const TOKEN_PREFIX = 'note_pat_';
const TOKEN_BYTES = 32;  // 256-bit secret

/**
 * One-line human descriptions per scope, surfaced to the Settings UI so
 * admins picking scopes at token-creation time don't have to guess what
 * each grants. Kept next to KNOWN_SCOPES so the two stay in sync — a
 * scope registered here but missing from KNOWN_SCOPES (or vice versa)
 * is a bug the wiring test catches on load.
 */
export const SCOPE_DESCRIPTIONS = {
  'mcp:read':    'MCP: read notes, checklists, and reminders.',
  'mcp:write':   'MCP: create and edit notes, add and check off checklist items, set reminders and labels. Requires MCP_WRITE_ENABLED=1 on the server.',
  'mcp:destroy': 'MCP: move notes to the trash. Requires MCP_DESTROY_ENABLED=1 AND every call to include confirm=true.',
  'notes:create': 'Public API: add notes and tasks (POST /api/v1/notes), and nothing else: no reading or changing other notes. For an email client, a script or an automation.',
};

export const KNOWN_SCOPES = new Set([
  // mcp:read unlocks the Model Context Protocol read tools, exposed
  // under /api/mcp when MCP_ENABLED=1. Lets a user's own agent inspect
  // their notes through the MCP standard interface.
  'mcp:read',
  // mcp:write unlocks MCP additive write tools. Independent of mcp:read
  // but tokens typically hold both. Requires MCP_WRITE_ENABLED=1 on
  // the server for any effect.
  'mcp:write',
  // mcp:destroy unlocks MCP destructive tools. Requires
  // MCP_DESTROY_ENABLED=1 on the server AND each destructive tool call
  // to include an explicit `confirm: true` argument. Kept separate from
  // mcp:write so an admin can grant "add stuff" without granting
  // "delete stuff".
  'mcp:destroy',
  // notes:create unlocks POST /api/v1/notes (routes/api-v1.js): another
  // app adds notes and tasks without being able to read or change any.
  // No server switch: holding the scope is the opt-in.
  'notes:create',
]);

// The scopes a non-admin may give their own tokens (routes/api-tokens.js).
// The MCP scopes stay admin-only.
export const USER_SCOPES = ['notes:create'];

/** An expiry "YYYY-MM-DD HH:MM:SS" (UTC) as epoch ms, or null if it isn't one. */
function _expiryMs(value) {
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, sec);
  // Date.UTC rolls Feb 30 into March; a real time reads back the same.
  return new Date(ms).toISOString().slice(0, 19) === `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` ? ms : null;
}

function _hash(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function _generateRaw() {
  // base64url is URL-safe and slightly shorter than hex
  const bytes = randomBytes(TOKEN_BYTES);
  const b64 = bytes.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return TOKEN_PREFIX + b64;
}

/**
 * Create a new token for a user.
 *
 * Returns { row, raw } where `raw` is the only place the plaintext
 * token ever exists. The caller is responsible for displaying it to
 * the user once and never logging it.
 */
export function createToken({ userId, name, scopes, expiresAt = null }) {
  if (!userId) throw new Error('userId required');
  const trimmedName = String(name || '').trim().slice(0, 80);
  if (!trimmedName) throw new Error('name required');
  // Stored the way SQLite writes datetime('now'): "YYYY-MM-DD HH:MM:SS",
  // UTC. Anything else used to be stored as given and never expire.
  if (expiresAt != null && _expiryMs(expiresAt) == null) {
    throw new Error('expires_at must be a UTC time like 2027-01-31 12:00:00');
  }

  // Validate scopes against known list. Drop unknowns silently rather
  // than throwing — forward-compatibility for clients that try to
  // request scopes from a future version.
  const requested = Array.isArray(scopes) ? scopes : [];
  const validScopes = requested.filter(s => KNOWN_SCOPES.has(String(s)));
  if (validScopes.length === 0) throw new Error('At least one valid scope required');

  const raw = _generateRaw();
  const hash = _hash(raw);
  const r = db.prepare(
    `INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, trimmedName, hash, JSON.stringify(validScopes), expiresAt);

  const row = db.prepare(
    `SELECT id, user_id, name, scopes, expires_at, last_used_at, created_at
       FROM api_tokens WHERE id = ?`
  ).get(r.lastInsertRowid);
  return { row: _parseRow(row), raw };
}

/** List tokens for a user. Never returns the hash or raw value. */
export function listTokens(userId) {
  return db.prepare(
    `SELECT id, user_id, name, scopes, expires_at, last_used_at, created_at
       FROM api_tokens
      WHERE user_id = ?
      ORDER BY created_at DESC`
  ).all(userId).map(_parseRow);
}

/** Revoke a token. Returns true if a row was removed. */
export function revokeToken({ userId, id }) {
  const r = db.prepare(
    `DELETE FROM api_tokens WHERE id = ? AND user_id = ?`
  ).run(id, userId);
  return r.changes > 0;
}

/**
 * Look up a token by its raw value. Returns the joined { token, user }
 * row or null. Updates last_used_at on a successful match.
 */
export function lookupRawToken(raw) {
  if (!raw || typeof raw !== 'string' || !raw.startsWith(TOKEN_PREFIX)) return null;
  const hash = _hash(raw);
  const row = db.prepare(
    `SELECT t.id, t.user_id, t.name, t.scopes, t.expires_at, t.last_used_at, t.created_at,
            u.username, u.full_name, u.role
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`
  ).get(hash);
  if (!row) return null;

  // Expiry check. A value that can't be read counts as expired: a
  // token meant to run out must never live on because of a typo.
  if (row.expires_at) {
    const expiresMs = _expiryMs(row.expires_at);
    if (expiresMs == null || expiresMs < Date.now()) return null;
  }

  // Touch last_used_at (best-effort; not in a transaction with the read)
  try {
    db.prepare(`UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
  } catch {}

  return {
    token: {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      scopes: _parseScopes(row.scopes),
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
      created_at: row.created_at,
    },
    user: {
      id: row.user_id,
      username: row.username,
      full_name: row.full_name,
      role: row.role,
    },
  };
}

function _parseRow(row) {
  if (!row) return null;
  return { ...row, scopes: _parseScopes(row.scopes) };
}

function _parseScopes(s) {
  try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
