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
import { snapshotVersion, tsMs } from '../lib/notes.js';
import { dispatchWebhookEvent } from '../lib/webhooks.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const userClause = (u) => u == null ? 'user_id IS NULL' : 'user_id = ?';
const userArgs   = (u) => u == null ? [] : [u];

// ── Table specs ──────────────────────────────────────────────────────
// `cols` - columns the client may WRITE via push. id / user_id /
//          created_at / sync_status / server_id are server-managed on
//          push. The pull endpoint still emits created_at so the client
//          can preserve the original creation timestamp locally.
// `parents` - FK columns + the table they reference. The client sends
//             FKs as server ids, except for parents created in the same
//             push, which it lists in the row's `_local_fks` array so the
//             server maps them through this push's client_id map.
// `uniqueKey` - natural key used to find an existing row when the client
//               has no server_id yet (two devices creating the same
//               checklist item uuid or the same note/label link).
// `softDelete` - uses deleted_at instead of hard delete.
const TABLES = {
  notes: {
    cols: [
      'title', 'body_md', 'kind', 'color', 'pinned', 'archived',
      'trashed_at', 'reminder_at', 'reminder_rrule', 'reminder_tz',
    ],
    parents: {},
    softDelete: true,
  },
  labels: {
    cols: ['name', 'color', 'position'],
    parents: {},
    softDelete: true,
  },
  checklist_items: {
    cols: ['uuid', 'note_id', 'text', 'checked', 'position'],
    parents: { note_id: 'notes' },
    uniqueKey: ['uuid'],
    softDelete: true,
  },
  note_labels: {
    cols: ['note_id', 'label_id'],
    parents: { note_id: 'notes', label_id: 'labels' },
    uniqueKey: ['note_id', 'label_id'],
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
const PUSH_ORDER = ['notes', 'labels', 'checklist_items', 'note_labels', 'ai_chat_history'];

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

    const txn = db.transaction(() => {
      for (const row of rows) {
        const translated = _translateParents(row, spec, idMaps, u);
        if (!translated) continue; // unresolvable or foreign parent; client retries next sync

        let existing = null;
        if (row.server_id) {
          existing = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(row.server_id);
          if (!existing) continue;
        } else if (spec.uniqueKey) {
          const where = spec.uniqueKey.map(k => `${k} = ?`).join(' AND ');
          existing = db.prepare(`SELECT * FROM ${name} WHERE ${where}`).get(...spec.uniqueKey.map(k => translated[k])) || null;
        }

        if (existing) {
          if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) continue;
          const incomingMs = tsMs(translated.updated_at);
          const serverMs = tsMs(existing.updated_at);
          const serverIsNewer = Number.isFinite(incomingMs) && Number.isFinite(serverMs) && serverMs > incomingMs;
          if (name === 'notes') _noteVersioning(existing, translated, serverIsNewer);
          if (serverIsNewer) {
            // Re-stamp the winning row so this device's next pull sends it
            // back down and replaces the stale local copy.
            db.prepare(`UPDATE ${name} SET synced_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`).run(existing.id);
          } else {
            // Columns the client didn't send keep their server value.
            const present = spec.cols.filter(c => translated[c] !== undefined);
            db.prepare(_buildUpdateSql(name, spec, present)).run(
              ...present.map(c => _coerce(translated[c])),
              translated.updated_at || _now(),
              spec.softDelete ? (translated.deleted_at ?? null) : null,
              existing.id
            );
          }
          // Acked either way: when the server copy is newer the client
          // marks its row synced and the pull brings the newer copy down.
          results[name].push({ client_id: row.client_id, server_id: existing.id });
          idMaps[name][row.client_id] = existing.id;
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
          const serverId = Number(info.lastInsertRowid);
          results[name].push({ client_id: row.client_id, server_id: serverId });
          idMaps[name][row.client_id] = serverId;
          if (name === 'notes' && !translated.deleted_at && u != null) {
            try { dispatchWebhookEvent(u, 'note.created', { note_id: serverId, title: translated.title || '', kind: translated.kind || 'text' }); }
            catch { /* never let a webhook failure block the sync */ }
          }
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
  // Taken before the queries so a write racing this pull is picked up
  // by the next one (>= below makes an overlap harmless: pulls are upserts).
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');

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
        WHERE ${userClause(u)} AND synced_at >= ?${orderBy}`
    ).all(...userArgs(u), since);
  }

  // Settings: only the keys that changed since the last pull.
  out.settings = db.prepare(
    `SELECT key, value, updated_at FROM user_settings
      WHERE ${userClause(u)} AND synced_at >= ?`
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

function _translateParents(row, spec, idMaps, u) {
  if (!spec.parents || !Object.keys(spec.parents).length) return row;
  const out = { ...row };
  const localFks = new Set(Array.isArray(row._local_fks) ? row._local_fks : []);
  for (const [fk, parentTable] of Object.entries(spec.parents)) {
    const raw = out[fk];
    if (raw == null) continue;
    if (localFks.has(fk)) {
      const mapped = idMaps[parentTable]?.[raw];
      if (!mapped) return null; // parent failed to push in this batch
      out[fk] = mapped;
      continue;
    }
    // A server id: the parent must exist and belong to the same owner,
    // or a client could attach rows to someone else's note.
    const parent = db.prepare(`SELECT user_id FROM ${parentTable} WHERE id = ?`).get(raw);
    if (!parent) return null;
    if ((u == null && parent.user_id != null) || (u != null && parent.user_id !== u)) return null;
  }
  return out;
}

// Notes never lose an edit to sync. When the server copy is newer, the
// incoming content is kept as a 'conflict' version; when the incoming
// copy wins, the server's previous content is snapshotted first.
function _noteVersioning(existing, incoming, serverIsNewer) {
  const changed = (incoming.title !== undefined && incoming.title !== existing.title)
    || (incoming.body_md !== undefined && incoming.body_md !== existing.body_md);
  if (!changed) return;
  if (serverIsNewer) {
    snapshotVersion(existing, 'conflict', {
      title: incoming.title ?? existing.title,
      body_md: incoming.body_md ?? existing.body_md,
      kind: incoming.kind ?? existing.kind,
    });
  } else {
    snapshotVersion(existing, 'edit');
  }
}

function _buildInsertSql(table, spec, present = spec.cols) {
  const cols = ['user_id', ...present, 'updated_at'];
  if (spec.softDelete) cols.push('deleted_at');
  const ph = cols.map(() => '?').join(', ');
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})`;
}

function _buildUpdateSql(table, spec, present = spec.cols) {
  // FK columns keep the server's value when the client pushes NULL.
  // The client always sends its full row (SELECT * on pending rows),
  // so a mobile push whose local row hasn't yet picked up a PWA-side
  // attach would clobber the server's newly-set FK with NULL. COALESCE
  // preserves the server's value unless the client explicitly sends a
  // non-null. Detaches still go through the explicit PUT route
  // routes, which use body.X !== undefined
  // semantics and correctly writes NULL when asked.
  const fkCols = new Set(Object.keys(spec.parents || {}));
  const setCols = present.map(c => (
    fkCols.has(c) ? `${c} = COALESCE(?, ${c})` : `${c} = ?`
  ));
  setCols.push('updated_at = ?');
  if (spec.softDelete) setCols.push('deleted_at = ?');
  return `UPDATE ${table} SET ${setCols.join(', ')} WHERE id = ?`;
}

export default router;
