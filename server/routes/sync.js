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
 *     row shape: { client_id, server_id?, client_key?, ...table-columns, updated_at, deleted_at }
 *     A row without server_id carries client_key, the app's stable key for
 *     it (lib/create-keys.js): sent again, it gets the row made the first
 *     time. Pulls return it to the account that made the row, so the app
 *     knows its own row when an answer was lost.
 *     response: { tables: { [name]: [{ client_id, server_id, deleted?, missing_parent? }] } }
 *     client_now (the phone's clock when it sent this) puts the phone's edit
 *     times on the server's clock for the rule below.
 *
 *   Deleted here, edited there (newer edit wins, by the server's clock):
 *     an edit made after the row was deleted brings it back (a note with
 *     the items, pictures and labels its delete took); an edit made before
 *     the delete loses, and the row is answered `deleted` so the device
 *     drops its copy instead of sending it again. A row (or a parent) this
 *     server no longer has, or another account's that this one can't
 *     reach, is never written: the row goes in as this account's, once
 *     (its client_key), and a child of a parent the server lost is
 *     answered `missing_parent` so the device sends the parent first.
 *
 *   GET /api/sync/pull?since=<ISO>[&keys=1]
 *     keys=1 (the app that sends client_key): rows come with it. Older apps
 *     store every column a row comes with, so they never get it.
 *     response: { now: 'ISO', tables: { [name]: [{ id, ...cols, updated_at, deleted_at }] },
 *                 revoked_notes: [serverNoteId, ...], chat_ids: [serverChatId, ...] }
 *     chat_ids: every chat message the account has now; the app drops the
 *     rest of its copy (chat is deleted outright here, never soft-deleted).
 *
 * Shared notes: a member's devices pull the notes shared with them (with
 * the member's own pin/archive/Show in Tasks, no reminder) plus share_role / share_owner
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
import { drawingText } from '../lib/drawing-meta.js';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { snapshotVersion, tsMs, noteAccess, restampNote, revokedNoteIds, cleanAttachmentUrl } from '../lib/notes.js';
import { dispatchWebhookEvent } from '../lib/webhooks.js';
import { isServerOnlyKey } from '../lib/server-only-keys.js';
import { cleanCreateKey, findByCreateKey, setCreateKey } from '../lib/create-keys.js';

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
      'title', 'body_md', 'kind', 'color', 'pinned', 'archived', 'in_tasks',
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
    cols: ['uuid', 'note_id', 'text', 'checked', 'position', 'due_date', 'due_repeat', 'checked_at'],
    parents: { note_id: 'notes' },
    uniqueKey: ['uuid'],
    softDelete: true,
  },
  note_attachments: {
    cols: ['uuid', 'note_id', 'url', 'mime', 'name', 'size_bytes', 'preview_url', 'drawing', 'width', 'height', 'position', 'duration_ms', 'extracted_text', 'summary', 'waveform', 'segments'],
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
  // The phone's clock against the server's, measured when the request
  // arrived (before its body uploaded). 0 for clients that don't say: the
  // web's outbox, and Android apps before these answers (`newApp`), which
  // get the answers they always got.
  const clientNow = Date.parse(req.body?.client_now);
  const newApp = Number.isFinite(clientNow);
  const arrived = req.receivedAt || Date.now();
  const skew = newApp && Math.abs(arrived - clientNow) < 366 * 86400000 ? arrived - clientNow : 0;
  const editMs = r => tsMs(r?.updated_at) + skew;
  const serverTime = t => { const ms = tsMs(t) + skew; return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : t; };
  // The newest edit of each existing note's items, pictures and labels in
  // this push (tombstones aside): an edit of what's in a note is an edit of
  // the note, when it meets the note's delete.
  const childEdit = new Map();
  for (const t of ['checklist_items', 'note_attachments', 'note_labels']) {
    for (const r of Array.isArray(tables[t]) ? tables[t] : []) {
      const local = Array.isArray(r._local_fks) && r._local_fks.includes('note_id');
      if (r.note_id == null || local || r.deleted_at) continue;
      const at = editMs(r);
      if (Number.isFinite(at) && !(childEdit.get(r.note_id) >= at)) childEdit.set(r.note_id, at);
    }
  }

  const idMaps = {};       // tableName → { client_id: server_id }
  const results = {};
  // The server id each pushed row went up with, to find a parent this same
  // push answered under another id (a copy the server didn't have as is).
  const sentAs = {};
  for (const [t, rs] of Object.entries(tables)) {
    if (!Array.isArray(rs)) continue;
    sentAs[t] = new Map();
    for (const r of rs) if (r?.server_id != null && r.client_id != null) sentAs[t].set(String(r.server_id), r.client_id);
  }

  for (const name of PUSH_ORDER) {
    if (!Array.isArray(tables[name])) { results[name] = []; continue; }
    const spec = TABLES[name];
    const rows = tables[name];
    idMaps[name] = idMaps[name] || {};
    results[name] = [];

    const txn = db.transaction(() => {
      for (const row of rows) {
        const translated = _translateParents(row, spec, idMaps, u, editMs(row), childEdit, sentAs);
        if (!translated) continue; // a parent in this same push didn't go in: next sync
        if (translated.__drop) {
          // Its note was deleted before this edit, or this account can't
          // change it: the edit is dropped. An app before these answers
          // gets none and sends it again later, as it always did.
          if (translated.__ownId) _restamp(name, translated.__ownId);
          if (newApp) {
            results[name].push({ client_id: row.client_id, ...(translated.__ownId ? { server_id: translated.__ownId } : {}), deleted: true, reason: translated.__drop });
          } else if (translated.__ownId) {
            // An older app marks it sent, and its next pull brings the row
            // as it is here (restamped).
            results[name].push({ client_id: row.client_id, server_id: translated.__ownId });
          }
          continue;
        }
        if (translated.__missingParent) {
          if (newApp) results[name].push({ client_id: row.client_id, missing_parent: translated.__missingParent });
          continue;
        }
        if (name === 'note_attachments' && translated.url) {
          // Only files on this server. A device-local path means the photo
          // hasn't uploaded yet; leave it unacked so it's sent again after
          // the next sync's upload pass.
          const clean = cleanAttachmentUrl(translated.url);
          if (!clean) continue;
          translated.url = clean;
          // A preview still on the device waits for the next upload pass; the file itself needn't.
          if ('preview_url' in translated) translated.preview_url = cleanAttachmentUrl(translated.preview_url);
          if ('drawing' in translated && translated.drawing != null) translated.drawing = drawingText(translated.drawing);
        }
        // A tombstone pushed here: deleted at the phone's time, on this
        // server's clock.
        if (spec.softDelete && translated.deleted_at) translated.deleted_at = serverTime(translated.deleted_at);

        let existing = null;
        // Items and images carry the note owner's id, whoever adds them.
        const rowOwner = () => ((name === 'checklist_items' || name === 'note_attachments')
          ? db.prepare(`SELECT user_id FROM notes WHERE id = ?`).get(translated.note_id)?.user_id ?? u
          : u);
        const createKey = cleanCreateKey(row.client_key);
        // A whole row (the Android app sends every column): one this server
        // no longer has can go in as new. The web's offline outbox sends
        // only what changed, which can't make a row.
        const whole = spec.cols.every(c => translated[c] !== undefined);
        let revived = false;
        if (row.server_id) {
          existing = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(row.server_id) || null;
          // Someone else's row this account was never given: never written.
          // Like a row this server no longer has, it goes in as new below.
          if (existing && !_reachable(name, existing, u)) existing = null;
          // Chat isn't made again: the server deleted it on purpose (Clear
          // Chat, the trim to the newest messages), or it's another
          // account's. Answered, so the phone stops sending it: the app
          // drops it now; an app before these answers marks it sent, and
          // its pull drops it (chat_ids). Chat a restored backup puts back
          // comes without a server id and goes in as new.
          if (!existing && name === 'ai_chat_history') {
            results[name].push(newApp ? { client_id: row.client_id, deleted: true, reason: 'deleted' } : { client_id: row.client_id });
            continue;
          }
          if (!existing && !whole) continue; // as before: nothing to make it from
        }
        if (!existing && spec.uniqueKey) {
          const where = spec.uniqueKey.map(k => `${k} = ?`).join(' AND ');
          existing = db.prepare(`SELECT * FROM ${name} WHERE ${where}`).get(...spec.uniqueKey.map(k => translated[k])) || null;
          // The same uuid is another account's row (a copy of someone
          // else's data): never theirs to change, and the uuid can't be
          // used twice. The device gives its row its own and sends it again.
          if (existing && !_reachable(name, existing, u)) {
            if (newApp) results[name].push({ client_id: row.client_id, uuid_taken: true });
            continue;
          }
        }
        // Made before from this very row (a retry, two syncs at once, an
        // answer lost): that row, never a second one.
        if (!existing && createKey) existing = findByCreateKey(name, rowOwner(), createKey);

        if (existing && name === 'notes' && u != null && existing.user_id !== u) {
          // Shared with this account (or once was): no access any more, or
          // the owner deleted it, and the member's copy goes.
          if (!noteAccess(u, existing.id)) {
            _restamp(name, existing.id);
            if (newApp) results[name].push({ client_id: row.client_id, server_id: existing.id, deleted: true, reason: 'access' });
            else results[name].push({ client_id: row.client_id, server_id: existing.id });
            continue;
          }
          _pushSharedNote(u, existing, translated);
          results[name].push({ client_id: row.client_id, server_id: existing.id });
          idMaps[name][row.client_id] = existing.id;
          continue;
        }
        if (existing && (name === 'checklist_items' || name === 'note_attachments')) {
          // Items and images follow their note: anyone who can edit the
          // note can edit them. Checked before anything is written.
          const access = noteAccess(u, existing.note_id);
          const note = access ? null : db.prepare(`SELECT user_id, deleted_at FROM notes WHERE id = ?`).get(existing.note_id);
          // This account's own note, deleted: a tombstone of its item goes
          // in as is; anything else was decided with the note above.
          const ownDeleted = note && note.deleted_at && (u == null ? note.user_id == null : note.user_id === u);
          if (!access && !(ownDeleted && translated.deleted_at)) {
            _restamp(name, existing.id);
            if (newApp) results[name].push({ client_id: row.client_id, server_id: existing.id, deleted: true, reason: ownDeleted ? 'deleted' : 'access' });
            else results[name].push({ client_id: row.client_id, server_id: existing.id });
            continue;
          }
          if (access?.role === 'view') {
            db.prepare(`UPDATE ${name} SET synced_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`).run(existing.id);
            results[name].push({ client_id: row.client_id, server_id: existing.id });
            continue;
          }
        } else if (existing) {
          if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) continue;
        }
        // Deleted here, edited there: the newer one wins, on the server's
        // clock (a note counts the newest edit of its items, pictures and
        // labels in this same push too). A tie keeps the delete.
        if (existing && spec.softDelete && existing.deleted_at && !translated.deleted_at) {
          const at = Math.max(editMs(translated), name === 'notes' ? (childEdit.get(existing.id) ?? -Infinity) : -Infinity);
          if (at > tsMs(existing.deleted_at)) {
            if (name === 'notes') _reviveNote(existing);
            else db.prepare(`UPDATE ${name} SET deleted_at = NULL WHERE id = ?`).run(existing.id);
            existing = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(existing.id);
            revived = true;
          } else {
            _restamp(name, existing.id);
            if (newApp) results[name].push({ client_id: row.client_id, server_id: existing.id, deleted: true, reason: 'deleted' });
            else results[name].push({ client_id: row.client_id, server_id: existing.id });
            continue;
          }
        }
        // A tombstone for a row already deleted here: nothing to change.
        if (existing && spec.softDelete && existing.deleted_at && translated.deleted_at) {
          results[name].push({ client_id: row.client_id, server_id: existing.id });
          idMaps[name][row.client_id] = existing.id;
          continue;
        }
        if (existing) {
          const incomingMs = tsMs(translated.updated_at);
          const serverMs = tsMs(existing.updated_at);
          const serverIsNewer = !revived && Number.isFinite(incomingMs) && Number.isFinite(serverMs) && serverMs > incomingMs;
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
              // Only tables that have deleted_at (chat doesn't) take one.
              ...(spec.softDelete ? [translated.deleted_at ?? null] : []),
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
            rowOwner(),
            ...present.map(c => _coerce(translated[c])),
            translated.updated_at || _now(),
            ...(spec.softDelete ? [translated.deleted_at ?? null] : [])
          );
          const serverId = Number(info.lastInsertRowid);
          setCreateKey(name, serverId, createKey);
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
  const withKeys = req.query.keys === '1';

  const out = {};
  for (const [name, spec] of Object.entries(TABLES)) {
    // created_at is included so the client can preserve the real
    // creation timestamp. Without it, dbApplyPull's INSERT omits the
    // column and SQLite's local `DEFAULT (datetime('now'))` stamps
    // every synced row with the pull-time clock, so every note ends
    // up looking like it was created on first-connect day.
    const cols = ['id', ...spec.cols, 'created_at', 'updated_at', ...(withKeys ? ['client_key'] : [])];
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
    if (name === 'notes') { out.notes = _pullNotes(u, since, withKeys); continue; }
    if ((name === 'checklist_items' || name === 'note_attachments') && u != null) {
      // Their own uuid matches them on the phone; a shared note's items
      // never carry anyone's install key to another account.
      out[name] = db.prepare(
        `SELECT ${cols.filter(c => c !== 'client_key').join(', ')} FROM ${name}
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

  // Every chat message this account has now. Clear Chat and the trim to
  // the newest messages delete chat outright, so the changed rows above
  // can't say so; the app keeps only these (db-native.js dbApplyPull).
  // Usually a couple of hundred ids at most (routes/ai.js MAX_HISTORY
  // trims on each new message); one id per message either way.
  const chat_ids = db.prepare(`SELECT id FROM ai_chat_history WHERE ${userClause(u)}`)
    .all(...userArgs(u)).map(r => r.id);

  res.json({ now, tables: out, revoked_notes: revokedNoteIds(u, since), chat_ids });
}));

// ── Helpers ──────────────────────────────────────────────────────────

function _now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function _coerce(v) {
  if (v === undefined) return null;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return v;
}

// Whether this account may write `existing`: its own, or (notes, and items
// and pictures of notes) one shared with it, now or before (the shared
// paths decide what it may change). Anything else is someone else's.
function _reachable(name, existing, u) {
  const own = u == null ? existing.user_id == null : existing.user_id === u;
  if (own) return true;
  if (u == null) return false;
  const noteId = name === 'notes' ? existing.id : (name === 'checklist_items' || name === 'note_attachments') ? existing.note_id : null;
  if (noteId == null) return false;
  const note = db.prepare(`SELECT user_id FROM notes WHERE id = ?`).get(noteId);
  if (note && note.user_id === u) return true;
  return !!db.prepare(`SELECT 1 FROM note_members WHERE note_id = ? AND user_id = ?`).get(noteId, u);
}

// Sent down again with the next pull (synced_at), unchanged.
function _restamp(name, id) {
  db.prepare(`UPDATE ${name} SET synced_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`).run(id);
}

// A note brought back by an edit newer than its delete: with the items,
// pictures and labels that delete took (they carry its time).
function _reviveNote(note) {
  const at = note.deleted_at;
  db.prepare(`UPDATE notes SET deleted_at = NULL WHERE id = ?`).run(note.id);
  db.prepare(`UPDATE checklist_items SET deleted_at = NULL WHERE note_id = ? AND deleted_at = ?`).run(note.id, at);
  db.prepare(`UPDATE note_attachments SET deleted_at = NULL WHERE note_id = ? AND deleted_at = ?`).run(note.id, at);
  db.prepare(`UPDATE note_labels SET deleted_at = NULL WHERE note_id = ? AND deleted_at = ?
    AND label_id IN (SELECT id FROM labels WHERE deleted_at IS NULL)`).run(note.id, at);
}

function _translateParents(row, spec, idMaps, u, editAt = NaN, childEdit = new Map(), sentAs = {}) {
  if (!spec.parents || !Object.keys(spec.parents).length) return row;
  const out = { ...row };
  const localFks = new Set(Array.isArray(row._local_fks) ? row._local_fks : []);
  const own = p => (u == null ? p.user_id == null : p.user_id === u);
  // A row of this table this account can reach, to answer with its id.
  const ownId = () => {
    if (!row.server_id) return null;
    const r = db.prepare(`SELECT * FROM ${Object.keys(TABLES).find(k => TABLES[k] === spec)} WHERE id = ?`).get(row.server_id);
    return r && _reachable(Object.keys(TABLES).find(k => TABLES[k] === spec), r, u) ? r.id : null;
  };
  for (const [fk, parentTable] of Object.entries(spec.parents)) {
    const raw = out[fk];
    if (raw == null) continue;
    if (localFks.has(fk)) {
      const mapped = idMaps[parentTable]?.[raw];
      if (!mapped) return null; // parent failed to push in this batch
      out[fk] = mapped;
      continue;
    }
    // A parent that went up in this push and was answered under another
    // id (the server didn't have it as sent): that one.
    const sentId = sentAs[parentTable]?.get(String(raw));
    const moved = sentId != null ? idMaps[parentTable]?.[sentId] : null;
    if (moved != null && String(moved) !== String(raw)) { out[fk] = moved; continue; }
    // A server id: the parent must exist and belong to the same owner,
    // or a client could attach rows to someone else's note. Shared notes
    // accept items from 'edit' members and labels from any member.
    if (parentTable === 'notes') {
      const access = noteAccess(u, raw);
      if (access) {
        if (fk === 'note_id' && (spec === TABLES.checklist_items || spec === TABLES.note_attachments) && access.role === 'view') return { __drop: 'access', __ownId: ownId() };
        continue;
      }
      const note = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(raw);
      // Gone from this server, or someone else's this account was never
      // given: the device sends the note up again first (as its own).
      if (!note || !_reachable('notes', note, u)) return { __missingParent: fk };
      if (own(note) && note.deleted_at) {
        // The phone's own tombstone of what's in the note: goes in as is.
        if (row.deleted_at) continue;
        // An edit of what's in a note made after the note's delete brings
        // it back; one made before is dropped (with the note's).
        const at = Math.max(editAt, childEdit.get(raw) ?? -Infinity);
        if (Number.isFinite(at) && at > tsMs(note.deleted_at)) { _reviveNote(note); continue; }
        return { __drop: 'deleted', __ownId: ownId() };
      }
      return { __drop: 'access', __ownId: ownId() }; // shared once, not any more (or trashed by its owner)
    }
    const parent = db.prepare(`SELECT user_id, deleted_at FROM ${parentTable} WHERE id = ?`).get(raw);
    if (!parent || !own(parent)) return { __missingParent: fk };
    if (parent.deleted_at && !row.deleted_at) return { __drop: 'deleted', __ownId: ownId() };
  }
  return out;
}

// Notes as a member's device sees them: the member's own pin and archive,
// no reminder (reminders belong to the owner), plus the share fields.
function _pullNotes(u, since, withKeys = false) {
  const key = withKeys ? ', client_key' : '';
  if (u == null) {
    return db.prepare(
      `SELECT id, ${TABLES.notes.cols.join(', ')}, created_at, updated_at, deleted_at${key},
              'owner' AS share_role, NULL AS share_owner, 0 AS share_count
         FROM notes WHERE user_id IS NULL AND synced_at >= ?`
    ).all(since);
  }
  return db.prepare(
    `SELECT n.id, n.title, n.body_md, n.kind, n.color,
            CASE WHEN m.id IS NULL THEN n.pinned ELSE m.pinned END AS pinned,
            CASE WHEN m.id IS NULL THEN n.archived ELSE m.archived END AS archived,
            CASE WHEN m.id IS NULL THEN n.in_tasks ELSE m.in_tasks END AS in_tasks,
            n.trashed_at,
            CASE WHEN m.id IS NULL THEN n.reminder_at END AS reminder_at,
            CASE WHEN m.id IS NULL THEN n.reminder_rrule END AS reminder_rrule,
            CASE WHEN m.id IS NULL THEN n.reminder_tz END AS reminder_tz,
            n.created_at, n.updated_at, n.deleted_at,${withKeys ? `
            CASE WHEN m.id IS NULL THEN n.client_key END AS client_key,` : ''}
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
  for (const col of ['pinned', 'archived', 'in_tasks']) {
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
