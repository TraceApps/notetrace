/**
 * sync.js — Differential push / pull for the Capacitor native app.
 *
 * The native app keeps a full local SQLite copy of every domain table
 * (db-native.js + api-native.js). When a server URL is configured,
 * local writes mark rows sync_status='pending' and the client-side
 * orchestrator (src/lib/sync.js) periodically reconciles via these
 * endpoints.
 *
 * Contract (kept close to NutriTrace's so the orchestrator pattern
 * ports without surgery):
 *
 *   POST /api/sync/push
 *     body: { tables: { [name]: [row, ...] }, settings: [{ key, value, updated_at }] }
 *     row shape: { client_id, server_id?, ...table-columns, updated_at, deleted_at }
 *     response: { tables: { [name]: [{ client_id, server_id }] } }
 *
 *   GET /api/sync/pull?since=<ISO>
 *     response: { now: 'ISO', tables: { [name]: [{ id, ...cols, updated_at, deleted_at }] } }
 *
 * Tables handled: notes, ai_chat_history (structural) plus user_settings
 * (key-value). Checklist items will use a per-item uuid merge with
 * tombstones instead of this whole-row path.
 *
 * FK translation on push: tables process in dependency order so parent
 * client_id to server_id mappings are available by the time child rows
 * are written.
 * On pull, parent tables arrive before children and the client side
 * translates FKs via `WHERE server_id = ?` lookups in db-native.
 */

import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const userClause = (u) => u == null ? 'user_id IS NULL' : 'user_id = ?';
const userArgs   = (u) => u == null ? [] : [u];

// ── Table specs ──────────────────────────────────────────────────────
// `cols` — columns the client may WRITE via push. id / user_id /
//          created_at / sync_status / server_id are server-managed on
//          push. NOTE: the pull endpoint below still emits created_at
//          separately so the client can preserve the original creation
//          timestamp when it INSERTs the pulled row into its local DB.
// `parents` — FK columns + the table they reference, used to rewrite
//             client-local ids into server ids during a push.
// `softDelete` — uses deleted_at instead of hard delete.
const TABLES = {
  notes: {
    cols: [
      'title', 'body_md', 'kind', 'color', 'pinned', 'archived',
      'trashed_at', 'reminder_at', 'reminder_rrule',
    ],
    parents: {},
    softDelete: true,
  },
  ai_chat_history: {
    cols: ['role', 'content'],
    parents: {},
    softDelete: false,
  },
};

// Process tables in dependency order so parents land first within a
// single push and child FKs can resolve against the freshly-minted ids.
const PUSH_ORDER = ['notes', 'ai_chat_history'];

// ── POST /push ────────────────────────────────────────────────────────
router.post('/push', wrap((req, res) => {
  const u = uid(req);
  const tables = req.body?.tables || {};

  const idMaps = {};       // tableName → { client_id: server_id }
  const results = {};

  for (const name of PUSH_ORDER) {
    if (!Array.isArray(tables[name])) { results[name] = []; continue; }
    const spec = TABLES[name];
    const rows = tables[name];
    idMaps[name] = idMaps[name] || {};
    results[name] = [];

    const updateSql = _buildUpdateSql(name, spec);

    const txn = db.transaction(() => {
      for (const row of rows) {
        const translated = _translateParents(row, spec, idMaps);
        const values = spec.cols.map(c => _coerce(translated[c]));

        if (row.server_id) {
          // Fetch the existing row to authorize the write.
          const existing = db.prepare(
            `SELECT * FROM ${name} WHERE id = ?`
          ).get(row.server_id);
          if (!existing) continue;
          if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) continue;
          db.prepare(updateSql).run(
            ...values,
            translated.updated_at || _now(),
            spec.softDelete ? (translated.deleted_at ?? null) : null,
            row.server_id
          );
          results[name].push({ client_id: row.client_id, server_id: row.server_id });
          idMaps[name][row.client_id] = row.server_id;
        } else {
          // Only bind columns the client actually sent, so omitted
          // columns fall back to their schema DEFAULTs instead of
          // tripping NOT NULL constraints.
          const present = spec.cols.filter(c => translated[c] !== undefined);
          const info = db.prepare(_buildInsertSql(name, spec, present)).run(
            u,
            ...present.map(c => _coerce(translated[c])),
            translated.updated_at || _now(),
            spec.softDelete ? (translated.deleted_at ?? null) : null
          );
          const serverId = info.lastInsertRowid;
          results[name].push({ client_id: row.client_id, server_id: serverId });
          idMaps[name][row.client_id] = serverId;
        }
      }
    });
    try { txn(); }
    catch (e) { results[name] = { error: e.message || 'push failed' }; }
  }

  // ── user_settings: key-value, server-side already has its own table.
  if (Array.isArray(req.body?.settings)) {
    const ins = db.prepare(
      `INSERT INTO user_settings (user_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    );
    const txn = db.transaction(() => {
      for (const s of req.body.settings) {
        ins.run(u, s.key, typeof s.value === 'string' ? s.value : JSON.stringify(s.value), s.updated_at || _now());
      }
    });
    try { txn(); } catch {}
  }

  res.json({ tables: results });
}));

// ── GET /pull ─────────────────────────────────────────────────────────
router.get('/pull', wrap((req, res) => {
  const u = uid(req);
  const since = (typeof req.query.since === 'string' && req.query.since) || '1970-01-01T00:00:00';
  const now = _now();

  const out = {};
  for (const [name, spec] of Object.entries(TABLES)) {
    // created_at is included so the client can preserve the real
    // creation timestamp. Without it, dbApplyPull's INSERT omits the
    // column and SQLite's local `DEFAULT (datetime('now'))` stamps
    // every synced row with the pull-time clock, so every note ends
    // up looking like it was created on first-connect day.
    const cols = ['id', ...spec.cols, 'created_at', 'updated_at'];
    if (spec.softDelete) cols.push('deleted_at');
    // Sort self-referencing tables so parents come before children in
    // the pull payload. The client's dbApplyPull scans server_id →
    // local_id fresh for each row, so a parent that arrives before its
    // child is available for FK translation on the child. Without
    // this ordering, a variant row that lands before its generic
    // parent in the payload would translate the parent FK to null and
    // the relationship silently disappears on the first sync after
    // it was attached (SQLite orders NULLs first in ASC by default,
    // so top-level parents naturally lead).
    const selfRef = Object.entries(spec.parents || {})
      .find(([, parentTable]) => parentTable === name);
    const orderBy = selfRef ? ` ORDER BY ${selfRef[0]} ASC, id ASC` : '';
    out[name] = db.prepare(
      `SELECT ${cols.join(', ')} FROM ${name}
        WHERE ${userClause(u)} AND updated_at > ?${orderBy}`
    ).all(...userArgs(u), since);
  }

  // Settings: only the keys that changed since the last pull.
  out.settings = db.prepare(
    `SELECT key, value, updated_at FROM user_settings
      WHERE ${userClause(u)} AND updated_at > ?`
  ).all(...userArgs(u), since);

  res.json({ now, tables: out });
}));

// ── Helpers ──────────────────────────────────────────────────────────

function _now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function _coerce(v) {
  if (v === undefined) return null;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return v;
}

function _translateParents(row, spec, idMaps) {
  if (!spec.parents) return row;
  const out = { ...row };
  for (const [fk, parentTable] of Object.entries(spec.parents)) {
    const raw = out[fk];
    if (raw == null) continue;
    const map = idMaps[parentTable];
    if (map && map[raw]) out[fk] = map[raw];
    // else: leave as-is. If the FK matches an existing server row it'll
    // resolve; otherwise the column either accepts NULL via ON DELETE
    // SET NULL semantics or surfaces a constraint error the client
    // retries on next sync.
  }
  return out;
}

function _buildInsertSql(table, spec, present = spec.cols) {
  const cols = ['user_id', ...present, 'updated_at'];
  if (spec.softDelete) cols.push('deleted_at');
  const ph = cols.map(() => '?').join(', ');
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})`;
}

function _buildUpdateSql(table, spec) {
  // FK columns keep the server's value when the client pushes NULL.
  // The client always sends its full row (SELECT * on pending rows),
  // so a mobile push whose local row hasn't yet picked up a PWA-side
  // attach would clobber the server's newly-set FK with NULL. COALESCE
  // preserves the server's value unless the client explicitly sends a
  // non-null. Detaches still go through the explicit PUT route
  // routes, which use body.X !== undefined
  // semantics and correctly writes NULL when asked.
  const fkCols = new Set(Object.keys(spec.parents || {}));
  const setCols = spec.cols.map(c => (
    fkCols.has(c) ? `${c} = COALESCE(?, ${c})` : `${c} = ?`
  ));
  setCols.push('updated_at = ?');
  if (spec.softDelete) setCols.push('deleted_at = ?');
  return `UPDATE ${table} SET ${setCols.join(', ')} WHERE id = ?`;
}

export default router;
