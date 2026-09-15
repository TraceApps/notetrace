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
 *     response: { now: 'ISO', tables: { [name]: [{ id, ...cols, updated_at, deleted_at }] },
 *                 revoked_notes: [serverNoteId, ...] }
 *
 * Shared notes: a member's devices pull the notes shared with them (with
 * the member's own pin/archive, no reminder) plus share_role / share_owner
 * / share_count. revoked_notes lists shared notes to drop locally (member
 * removed, left, or the owner trashed or deleted the note). A member's
 * push may change content only with 'edit'; pin and archive go to their
 * membership; trash and reminders from a member are ignored.
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
import { snapshotVersion, tsMs, noteAccess, restampNote, revokedNoteIds, cleanAttachmentUrl } from '../lib/notes.js';
import { dispatchWebhookEvent } from '../lib/webhooks.js';
import { isServerOnlyKey } from '../lib/server-only-keys.js';

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
    cols: ['name', 'color', 'icon', 'position'],
    parents: {},
    softDelete: true,
  },
  checklist_items: {
    cols: ['uuid', 'note_id', 'text', 'checked', 'position', 'due_date'],
    parents: { note_id: 'notes' },
    uniqueKey: ['uuid'],
    softDelete: true,
  },
  note_attachments: {
    cols: ['uuid', 'note_id', 'url', 'mime', 'width', 'height', 'position', 'duration_ms', 'extracted_text'],
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
const PUSH_ORDER = ['notes', 'labels', 'checklist_items', 'note_attachments', 'note_labels', 'ai_chat_history'];

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
        if (name === 'note_attachments' && translated.url) {
          // Only files on this server. A device-local path means the photo
          // hasn't uploaded yet; leave it unacked so it's sent again after
          // the next sync's upload pass.
          const clean = cleanAttachmentUrl(translated.url);
          if (!clean) continue;
          translated.url = clean;
        }

        let existing = null;
        if (row.server_id) {
          existing = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(row.server_id);
          if (!existing) continue;
        } else if (spec.uniqueKey) {
          const where = spec.uniqueKey.map(k => `${k} = ?`).join(' AND ');
          existing = db.prepare(`SELECT * FROM ${name} WHERE ${where}`).get(...spec.uniqueKey.map(k => translated[k])) || null;
        }

        if (existing && name === 'notes' && u != null && existing.user_id !== u) {
          _pushSharedNote(u, existing, translated);
          results[name].push({ client_id: row.client_id, server_id: existing.id });
          idMaps[name][row.client_id] = existing.id;
          continue;
        }
        if (existing && (name === 'checklist_items' || name === 'note_attachments')) {
          // Items and images follow their note: anyone who can edit the note can edit them.
          const access = noteAccess(u, existing.note_id);
          if (!access || access.role === 'view') {
            db.prepare(`UPDATE ${name} SET synced_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`).run(existing.id);
            results[name].push({ client_id: row.client_id, server_id: existing.id });
            continue;
          }
        } else if (existing) {
          if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) continue;
        }
        if (existing) {
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
          // Items and images carry the note owner's id, whoever adds them.
          const rowOwner = (name === 'checklist_items' || name === 'note_attachments')
            ? db.prepare(`SELECT user_id FROM notes WHERE id = ?`).get(translated.note_id)?.user_id ?? u
            : u;
          const info = db.prepare(_buildInsertSql(name, spec, present)).run(
            rowOwner,
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
        if (!s?.key || isServerOnlyKey(s.key)) continue;
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
    if (name === 'notes') { out.notes = _pullNotes(u, since); continue; }
    if ((name === 'checklist_items' || name === 'note_attachments') && u != null) {
      out[name] = db.prepare(
        `SELECT ${cols.join(', ')} FROM ${name}
          WHERE synced_at >= ? AND note_id IN (
            SELECT id FROM notes WHERE user_id = ?
            UNION SELECT note_id FROM note_members WHERE user_id = ? AND deleted_at IS NULL)`
      ).all(since, u, u);
      continue;
    }
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
  ).all(...userArgs(u), since).filter(r => !isServerOnlyKey(r.key));

  res.json({ now, tables: out, revoked_notes: revokedNoteIds(u, since) });
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
    // or a client could attach rows to someone else's note. Shared notes
    // accept items from 'edit' members and labels from any member.
    if (parentTable === 'notes' && u != null) {
      const access = noteAccess(u, raw);
      if (!access) return null;
      if (fk === 'note_id' && (spec === TABLES.checklist_items || spec === TABLES.note_attachments) && access.role === 'view') return null;
      continue;
    }
    const parent = db.prepare(`SELECT user_id FROM ${parentTable} WHERE id = ?`).get(raw);
    if (!parent) return null;
    if ((u == null && parent.user_id != null) || (u != null && parent.user_id !== u)) return null;
  }
  return out;
}

// Notes as a member's device sees them: the member's own pin and archive,
// no reminder (reminders belong to the owner), plus the share fields.
function _pullNotes(u, since) {
  if (u == null) {
    return db.prepare(
      `SELECT id, ${TABLES.notes.cols.join(', ')}, created_at, updated_at, deleted_at,
              'owner' AS share_role, NULL AS share_owner, 0 AS share_count
         FROM notes WHERE user_id IS NULL AND synced_at >= ?`
    ).all(since);
  }
  return db.prepare(
    `SELECT n.id, n.title, n.body_md, n.kind, n.color,
            CASE WHEN m.id IS NULL THEN n.pinned ELSE m.pinned END AS pinned,
            CASE WHEN m.id IS NULL THEN n.archived ELSE m.archived END AS archived,
            n.trashed_at,
            CASE WHEN m.id IS NULL THEN n.reminder_at END AS reminder_at,
            CASE WHEN m.id IS NULL THEN n.reminder_rrule END AS reminder_rrule,
            CASE WHEN m.id IS NULL THEN n.reminder_tz END AS reminder_tz,
            n.created_at, n.updated_at, n.deleted_at,
            COALESCE(m.role, 'owner') AS share_role,
            CASE WHEN m.id IS NULL THEN NULL ELSE COALESCE(o.full_name, o.username) END AS share_owner,
            (SELECT COUNT(*) FROM note_members c WHERE c.note_id = n.id AND c.deleted_at IS NULL) AS share_count
       FROM notes n
       LEFT JOIN note_members m ON m.note_id = n.id AND m.user_id = ? AND m.deleted_at IS NULL
       LEFT JOIN users o ON o.id = n.user_id
      WHERE n.synced_at >= ? AND (n.user_id = ? OR (m.id IS NOT NULL AND n.trashed_at IS NULL))`
  ).all(u, since, u);
}

// A member pushing a shared note. Anything they may not change is
// dropped, and the note is re-stamped so their next pull restores the
// server copy over their local one.
function _pushSharedNote(u, existing, incoming) {
  const access = noteAccess(u, existing.id);
  if (!access || access.role === 'owner') return; // revoked: the pull's revoked_notes cleans up
  let rejected = !!(incoming.trashed_at || incoming.deleted_at);

  const mine = [];
  const mineArgs = [];
  for (const col of ['pinned', 'archived']) {
    if (incoming[col] === undefined) continue;
    const v = incoming[col] ? 1 : 0;
    if (v !== access.member[col]) { mine.push(`${col} = ?`); mineArgs.push(v); }
  }
  if (mine.length) {
    db.prepare(`UPDATE note_members SET ${mine.join(', ')}, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`)
      .run(...mineArgs, access.member.id);
  }

  const contentCols = ['title', 'body_md', 'kind', 'color'].filter(c => incoming[c] !== undefined && incoming[c] !== existing[c]);
  if (contentCols.length) {
    if (access.role !== 'edit') rejected = true;
    else {
      const incomingMs = tsMs(incoming.updated_at);
      const serverMs = tsMs(existing.updated_at);
      const serverIsNewer = Number.isFinite(incomingMs) && Number.isFinite(serverMs) && serverMs > incomingMs;
      _noteVersioning(existing, incoming, serverIsNewer);
      if (serverIsNewer) rejected = true;
      else {
        db.prepare(`UPDATE notes SET ${contentCols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...contentCols.map(c => _coerce(incoming[c])), incoming.updated_at || _now(), existing.id);
      }
    }
  }
  if (rejected || mine.length) restampNote(existing.id);
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
