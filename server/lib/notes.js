/**
 * server/lib/notes.js
 *
 * Core note operations shared by the REST routes, sync push, and (later)
 * MCP tools, so the rules live in one place:
 *   - version snapshots at edit-session boundaries and on conflicts
 *   - trash vs permanent delete (tombstones for sync)
 *   - checklist items as independent rows keyed by a stable uuid
 *   - label links as soft-deletable rows
 *
 * Every function takes the owner id `u` (null in single-user mode) and
 * scopes every query on it.
 */
import { randomUUID } from 'crypto';
import db from '../db.js';
import { dispatchWebhookEvent } from './webhooks.js';

export const NOTE_KINDS = new Set(['text', 'checklist']);
export const NOTE_COLORS = new Set(['plum', 'moss', 'clay', 'tide', 'sand', 'rose']);
export const TRASH_RETENTION_DAYS = 30;
export const REMINDER_REPEATS = new Set(['daily', 'weekly', 'monthly', 'yearly']);

// A new version is only written when the previous one is older than
// this, so one editing session produces one restore point instead of
// one per autosave.
const VERSION_SESSION_MS = 10 * 60 * 1000;
const VERSION_KEEP_PER_NOTE = 50;

const userClause = (u, col = 'user_id') => u == null ? `${col} IS NULL` : `${col} = ?`;
const userArgs   = (u) => u == null ? [] : [u];

export function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Parse any stored timestamp shape to epoch ms (NaN when unparseable). */
export function tsMs(s) {
  if (!s) return NaN;
  const str = String(s);
  const iso = str.includes('T') ? str : str.replace(' ', 'T');
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
}

function _emit(u, event, data) {
  if (u == null) return;
  try { dispatchWebhookEvent(u, event, data); } catch { /* never let a webhook failure block the save */ }
}

// ── Reads ────────────────────────────────────────────────────────────

function _itemsFor(noteIds) {
  if (!noteIds.length) return new Map();
  const ph = noteIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT note_id, uuid, text, checked, position FROM checklist_items
      WHERE note_id IN (${ph}) AND deleted_at IS NULL
      ORDER BY position ASC, id ASC`
  ).all(...noteIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.note_id)) map.set(r.note_id, []);
    map.get(r.note_id).push({ uuid: r.uuid, text: r.text, checked: !!r.checked, position: r.position });
  }
  return map;
}

function _labelsFor(noteIds) {
  if (!noteIds.length) return new Map();
  const ph = noteIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT nl.note_id, nl.label_id FROM note_labels nl
       JOIN labels l ON l.id = nl.label_id AND l.deleted_at IS NULL
      WHERE nl.note_id IN (${ph}) AND nl.deleted_at IS NULL`
  ).all(...noteIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.note_id)) map.set(r.note_id, []);
    map.get(r.note_id).push(r.label_id);
  }
  return map;
}

function _hydrate(rows) {
  const ids = rows.map(r => r.id);
  const items = _itemsFor(ids);
  const labels = _labelsFor(ids);
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    body_md: r.body_md,
    kind: r.kind,
    color: r.color,
    pinned: !!r.pinned,
    archived: !!r.archived,
    trashed_at: r.trashed_at,
    reminder_at: r.reminder_at,
    reminder_rrule: r.reminder_rrule,
    reminder_tz: r.reminder_tz,
    created_at: r.created_at,
    updated_at: r.updated_at,
    labels: labels.get(r.id) || [],
    items: items.get(r.id) || [],
  }));
}

/** Turn free text into a safe FTS5 prefix query ("foo bar" → "foo"* "bar"*). */
export function ftsQuery(q) {
  const words = String(q || '').match(/[\p{L}\p{N}]+/gu) || [];
  return words.slice(0, 12).map(w => `"${w}"*`).join(' ');
}

/**
 * List notes for a view.
 *   view: 'notes' (default) | 'archive' | 'trash' | 'reminders'
 *   labelId: only notes carrying this label
 *   q: full-text search across title, body and checklist items
 */
export function listNotes(u, { view = 'notes', labelId = null, q = '' } = {}) {
  const where = [userClause(u, 'n.user_id'), 'n.deleted_at IS NULL'];
  const args = [...userArgs(u)];
  if (view === 'trash') where.push('n.trashed_at IS NOT NULL');
  else if (view === 'reminders') {
    where.push('n.trashed_at IS NULL', 'n.reminder_at IS NOT NULL');
  } else {
    where.push('n.trashed_at IS NULL');
    where.push(view === 'archive' ? 'n.archived = 1' : 'n.archived = 0');
  }
  let join = '';
  if (labelId != null) {
    join += ' JOIN note_labels nl ON nl.note_id = n.id AND nl.deleted_at IS NULL AND nl.label_id = ?';
    args.unshift(labelId);
  }
  const match = ftsQuery(q);
  if (match) {
    join += ' JOIN notes_fts f ON f.rowid = n.id';
    where.push('notes_fts MATCH ?');
    args.push(match);
  }
  const order = view === 'notes' ? 'n.pinned DESC, n.updated_at DESC'
    : view === 'reminders' ? 'n.reminder_at ASC'
    : 'n.updated_at DESC';
  const rows = db.prepare(
    `SELECT n.* FROM notes n${join} WHERE ${where.join(' AND ')} ORDER BY ${order}`
  ).all(...args);
  return _hydrate(rows);
}

function _row(u, id) {
  return db.prepare(
    `SELECT * FROM notes WHERE id = ? AND ${userClause(u)} AND deleted_at IS NULL`
  ).get(id, ...userArgs(u));
}

export function getNote(u, id) {
  const row = _row(u, id);
  return row ? _hydrate([row])[0] : null;
}

// ── Versions ─────────────────────────────────────────────────────────

function _itemsJson(noteId) {
  const rows = db.prepare(
    `SELECT uuid, text, checked, position FROM checklist_items
      WHERE note_id = ? AND deleted_at IS NULL ORDER BY position ASC, id ASC`
  ).all(noteId);
  return rows.length ? JSON.stringify(rows.map(r => ({ ...r, checked: !!r.checked }))) : null;
}

/**
 * Snapshot a note's current content before it changes. 'edit' snapshots
 * are skipped inside an editing session; 'conflict' and 'restore'
 * snapshots are always written.
 */
export function snapshotVersion(noteRow, reason = 'edit', content = null) {
  if (!noteRow) return;
  if (reason === 'edit') {
    const last = db.prepare(
      `SELECT created_at FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 1`
    ).get(noteRow.id);
    if (last && Date.now() - tsMs(last.created_at) < VERSION_SESSION_MS) return;
  }
  const src = content || {
    title: noteRow.title, body_md: noteRow.body_md, kind: noteRow.kind,
    items_json: _itemsJson(noteRow.id),
  };
  if (!src.title && !src.body_md && !src.items_json) return; // nothing worth keeping
  db.prepare(
    `INSERT INTO note_versions (note_id, title, body_md, kind, items_json, reason)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(noteRow.id, src.title || '', src.body_md || '', src.kind || 'text', src.items_json || null, reason);
  db.prepare(
    `DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (
       SELECT id FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT ?)`
  ).run(noteRow.id, noteRow.id, VERSION_KEEP_PER_NOTE);
}

export function listVersions(u, noteId) {
  if (!_rowAny(u, noteId)) return null;
  return db.prepare(
    `SELECT id, title, body_md, kind, items_json, reason, created_at
       FROM note_versions WHERE note_id = ? ORDER BY id DESC`
  ).all(noteId).map(v => ({ ...v, items: v.items_json ? JSON.parse(v.items_json) : [], items_json: undefined }));
}

function _rowAny(u, id) {
  return db.prepare(
    `SELECT * FROM notes WHERE id = ? AND ${userClause(u)} AND deleted_at IS NULL`
  ).get(id, ...userArgs(u));
}

export const restoreVersion = db.transaction((u, noteId, versionId) => {
  const row = _rowAny(u, noteId);
  if (!row) return null;
  const v = db.prepare(`SELECT * FROM note_versions WHERE id = ? AND note_id = ?`).get(versionId, noteId);
  if (!v) return null;
  snapshotVersion(row, 'restore');
  const ts = now();
  db.prepare(`UPDATE notes SET title = ?, body_md = ?, kind = ?, updated_at = ? WHERE id = ?`)
    .run(v.title, v.body_md, v.kind, ts, noteId);
  if (v.kind === 'checklist') {
    const items = v.items_json ? JSON.parse(v.items_json) : [];
    db.prepare(`UPDATE checklist_items SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND deleted_at IS NULL`)
      .run(ts, ts, noteId);
    items.forEach((it, i) => _upsertItem(u, noteId, { text: it.text, checked: it.checked, position: i + 1 }, ts));
  }
  return getNote(u, noteId);
});

// ── Writes ───────────────────────────────────────────────────────────

function _cleanTitle(v) { return String(v ?? '').slice(0, 1000); }
function _cleanBody(v)  { return String(v ?? '').slice(0, 1_000_000); }
function _cleanColor(v) { return NOTE_COLORS.has(v) ? v : null; }
function _cleanReminderAt(v) {
  if (v == null || v === '') return null;
  const ms = tsMs(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : null;
}
function _cleanRepeat(v) { return REMINDER_REPEATS.has(v) ? v : null; }
function _cleanTz(v) {
  if (typeof v !== 'string' || !v || v.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return v; } catch { return null; }
}

function _upsertItem(u, noteId, it, ts) {
  const uuid = typeof it.uuid === 'string' && it.uuid ? it.uuid : randomUUID();
  db.prepare(
    `INSERT INTO checklist_items (uuid, user_id, note_id, text, checked, position, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(uuid) DO UPDATE SET
       text = excluded.text, checked = excluded.checked, position = excluded.position,
       updated_at = excluded.updated_at, deleted_at = NULL
     WHERE checklist_items.note_id = excluded.note_id`
  ).run(uuid, u, noteId, String(it.text ?? '').slice(0, 5000), it.checked ? 1 : 0,
        Number.isFinite(+it.position) ? +it.position : 0, ts, ts);
  return uuid;
}

export const createNote = db.transaction((u, data = {}) => {
  const ts = now();
  const kind = NOTE_KINDS.has(data.kind) ? data.kind : 'text';
  const info = db.prepare(
    `INSERT INTO notes (user_id, title, body_md, kind, color, pinned, archived,
                        reminder_at, reminder_rrule, reminder_tz, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(u, _cleanTitle(data.title), kind === 'text' ? _cleanBody(data.body_md) : '',
        kind, _cleanColor(data.color), data.pinned ? 1 : 0, data.archived ? 1 : 0,
        _cleanReminderAt(data.reminder_at), _cleanRepeat(data.reminder_rrule), _cleanTz(data.reminder_tz), ts, ts);
  const id = Number(info.lastInsertRowid);
  if (kind === 'checklist' && Array.isArray(data.items)) {
    data.items.forEach((it, i) => _upsertItem(u, id, { ...it, position: it.position ?? i + 1 }, ts));
  }
  if (Array.isArray(data.labels)) _setLabels(u, id, data.labels, ts);
  const note = getNote(u, id);
  _emit(u, 'note.created', { note_id: id, title: note.title, kind: note.kind });
  return note;
});

/** Partial update. Only fields present in `patch` change. */
export const updateNote = db.transaction((u, id, patch = {}) => {
  const row = _row(u, id);
  if (!row) return null;
  const sets = [];
  const args = [];
  const contentChanging =
    ('title' in patch && _cleanTitle(patch.title) !== row.title) ||
    ('body_md' in patch && _cleanBody(patch.body_md) !== row.body_md);
  if (contentChanging) snapshotVersion(row, 'edit');
  if ('title' in patch)   { sets.push('title = ?');   args.push(_cleanTitle(patch.title)); }
  if ('body_md' in patch) { sets.push('body_md = ?'); args.push(_cleanBody(patch.body_md)); }
  if ('color' in patch)   { sets.push('color = ?');   args.push(_cleanColor(patch.color)); }
  if ('pinned' in patch)  { sets.push('pinned = ?');  args.push(patch.pinned ? 1 : 0); }
  if ('archived' in patch) {
    sets.push('archived = ?'); args.push(patch.archived ? 1 : 0);
    if (patch.archived) { sets.push('pinned = 0'); }
  }
  if ('reminder_at' in patch) {
    const at = _cleanReminderAt(patch.reminder_at);
    sets.push('reminder_at = ?'); args.push(at);
    if (!at) sets.push('reminder_rrule = NULL', 'reminder_tz = NULL');
  }
  const nextReminderAt = 'reminder_at' in patch ? _cleanReminderAt(patch.reminder_at) : row.reminder_at;
  if ('reminder_rrule' in patch && nextReminderAt) {
    sets.push('reminder_rrule = ?'); args.push(_cleanRepeat(patch.reminder_rrule));
  }
  if ('reminder_tz' in patch && nextReminderAt) { sets.push('reminder_tz = ?'); args.push(_cleanTz(patch.reminder_tz)); }
  const ts = now();
  if (sets.length) {
    db.prepare(`UPDATE notes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, ts, id);
  }
  if (Array.isArray(patch.labels)) _setLabels(u, id, patch.labels, ts);
  return getNote(u, id);
});

/** Switch a note between text and checklist without losing content. */
export const convertNote = db.transaction((u, id, kind) => {
  const row = _row(u, id);
  if (!row || !NOTE_KINDS.has(kind) || row.kind === kind) return row ? getNote(u, id) : null;
  snapshotVersion(row, 'restore');
  const ts = now();
  if (kind === 'checklist') {
    const lines = String(row.body_md || '').split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const task = l.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
        if (task) return { text: task[2], checked: task[1].toLowerCase() === 'x' };
        const bare = l.replace(/^([-*+]|\d+[.)])\s+/, '');
        const struck = bare.match(/^~~(.+)~~$/);
        return struck ? { text: struck[1], checked: true } : { text: bare, checked: false };
      });
    lines.forEach((it, i) => _upsertItem(u, id, { ...it, position: i + 1 }, ts));
    db.prepare(`UPDATE notes SET kind = 'checklist', body_md = '', updated_at = ? WHERE id = ?`).run(ts, id);
  } else {
    const items = db.prepare(
      `SELECT text, checked FROM checklist_items WHERE note_id = ? AND deleted_at IS NULL ORDER BY position, id`
    ).all(id);
    const body = items.map(it => it.checked ? `~~${it.text}~~` : it.text).join('\n\n');
    db.prepare(`UPDATE checklist_items SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND deleted_at IS NULL`)
      .run(ts, ts, id);
    db.prepare(`UPDATE notes SET kind = 'text', body_md = ?, updated_at = ? WHERE id = ?`).run(body, ts, id);
  }
  return getNote(u, id);
});

export function trashNote(u, id) {
  const row = _row(u, id);
  if (!row) return null;
  const ts = now();
  db.prepare(`UPDATE notes SET trashed_at = ?, pinned = 0, updated_at = ? WHERE id = ?`).run(ts, ts, id);
  return getNote(u, id);
}

export function restoreNote(u, id) {
  const row = _row(u, id);
  if (!row) return null;
  db.prepare(`UPDATE notes SET trashed_at = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
  return getNote(u, id);
}

/** Permanent delete: tombstone the note and everything hanging off it. */
export const deleteNoteForever = db.transaction((u, id) => {
  const row = _row(u, id);
  if (!row) return false;
  const ts = now();
  db.prepare(`UPDATE checklist_items SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND deleted_at IS NULL`).run(ts, ts, id);
  db.prepare(`UPDATE note_labels SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND deleted_at IS NULL`).run(ts, ts, id);
  db.prepare(`UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, id);
  db.prepare(`DELETE FROM note_versions WHERE note_id = ?`).run(id);
  return true;
});

export function emptyTrash(u) {
  const ids = db.prepare(
    `SELECT id FROM notes WHERE ${userClause(u)} AND trashed_at IS NOT NULL AND deleted_at IS NULL`
  ).all(...userArgs(u)).map(r => r.id);
  for (const id of ids) deleteNoteForever(u, id);
  return ids.length;
}

/** Scheduler hook: permanently delete notes trashed longer than the retention window. */
export function purgeExpiredTrash() {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const rows = db.prepare(
    `SELECT id, user_id FROM notes WHERE trashed_at IS NOT NULL AND trashed_at < ? AND deleted_at IS NULL`
  ).all(cutoff);
  for (const r of rows) deleteNoteForever(r.user_id, r.id);
  return rows.length;
}

// ── Checklist items ──────────────────────────────────────────────────

function _checklistCompleted(noteId) {
  const r = db.prepare(
    `SELECT COUNT(*) AS total, SUM(checked) AS done FROM checklist_items WHERE note_id = ? AND deleted_at IS NULL`
  ).get(noteId);
  return r.total > 0 && r.done === r.total;
}

function _touch(noteId, ts) {
  db.prepare(`UPDATE notes SET updated_at = ? WHERE id = ?`).run(ts, noteId);
}

export const addItem = db.transaction((u, noteId, data = {}) => {
  const row = _row(u, noteId);
  if (!row || row.kind !== 'checklist') return null;
  const ts = now();
  let position = Number(data.position);
  if (!Number.isFinite(position)) {
    const max = db.prepare(`SELECT MAX(position) AS p FROM checklist_items WHERE note_id = ? AND deleted_at IS NULL`).get(noteId);
    position = (max.p || 0) + 1;
  }
  _upsertItem(u, noteId, { uuid: data.uuid, text: data.text, checked: data.checked, position }, ts);
  _touch(noteId, ts);
  return getNote(u, noteId);
});

export const updateItem = db.transaction((u, noteId, uuid, patch = {}) => {
  const row = _row(u, noteId);
  if (!row) return null;
  const item = db.prepare(`SELECT * FROM checklist_items WHERE uuid = ? AND note_id = ? AND deleted_at IS NULL`).get(uuid, noteId);
  if (!item) return null;
  const wasComplete = _checklistCompleted(noteId);
  const ts = now();
  _upsertItem(u, noteId, {
    uuid,
    text: 'text' in patch ? patch.text : item.text,
    checked: 'checked' in patch ? patch.checked : item.checked,
    position: 'position' in patch ? patch.position : item.position,
  }, ts);
  _touch(noteId, ts);
  if (!wasComplete && _checklistCompleted(noteId)) {
    _emit(u, 'checklist.completed', { note_id: noteId, title: row.title });
  }
  return getNote(u, noteId);
});

export const deleteItem = db.transaction((u, noteId, uuid) => {
  const row = _row(u, noteId);
  if (!row) return null;
  const ts = now();
  db.prepare(`UPDATE checklist_items SET deleted_at = ?, updated_at = ? WHERE uuid = ? AND note_id = ?`).run(ts, ts, uuid, noteId);
  _touch(noteId, ts);
  return getNote(u, noteId);
});

/** Set item order from a list of uuids. Items not listed keep their position. */
export const reorderItems = db.transaction((u, noteId, uuids = []) => {
  const row = _row(u, noteId);
  if (!row) return null;
  const ts = now();
  const upd = db.prepare(`UPDATE checklist_items SET position = ?, updated_at = ? WHERE uuid = ? AND note_id = ? AND deleted_at IS NULL`);
  uuids.forEach((uuid, i) => upd.run(i + 1, ts, uuid, noteId));
  _touch(noteId, ts);
  return getNote(u, noteId);
});

// ── Labels ───────────────────────────────────────────────────────────

function _setLabels(u, noteId, labelIds, ts) {
  const wanted = new Set(labelIds.map(Number).filter(Number.isFinite));
  const owned = new Set(db.prepare(
    `SELECT id FROM labels WHERE ${userClause(u)} AND deleted_at IS NULL`
  ).all(...userArgs(u)).map(r => r.id));
  const existing = db.prepare(`SELECT label_id, deleted_at FROM note_labels WHERE note_id = ?`).all(noteId);
  const current = new Set(existing.filter(r => !r.deleted_at).map(r => r.label_id));
  for (const lid of wanted) {
    if (!owned.has(lid) || current.has(lid)) continue;
    db.prepare(
      `INSERT INTO note_labels (user_id, note_id, label_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(note_id, label_id) DO UPDATE SET deleted_at = NULL, updated_at = excluded.updated_at`
    ).run(u, noteId, lid, ts, ts);
  }
  for (const lid of current) {
    if (wanted.has(lid)) continue;
    db.prepare(`UPDATE note_labels SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND label_id = ?`).run(ts, ts, noteId, lid);
  }
}

export function listLabels(u) {
  return db.prepare(
    `SELECT l.id, l.name, l.color, l.position, l.created_at, l.updated_at,
            (SELECT COUNT(*) FROM note_labels nl JOIN notes n ON n.id = nl.note_id
              WHERE nl.label_id = l.id AND nl.deleted_at IS NULL
                AND n.deleted_at IS NULL AND n.trashed_at IS NULL) AS note_count
       FROM labels l WHERE ${userClause(u, 'l.user_id')} AND l.deleted_at IS NULL
      ORDER BY l.position ASC, l.name COLLATE NOCASE ASC`
  ).all(...userArgs(u));
}

function _labelNameTaken(u, name, exceptId = null) {
  return !!db.prepare(
    `SELECT 1 FROM labels WHERE ${userClause(u)} AND deleted_at IS NULL AND name = ? COLLATE NOCASE AND id IS NOT ?`
  ).get(...userArgs(u), name, exceptId);
}

export function createLabel(u, { name, color } = {}) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return { error: 'Label name required' };
  if (_labelNameTaken(u, clean)) return { error: 'A label with that name already exists' };
  const max = db.prepare(`SELECT MAX(position) AS p FROM labels WHERE ${userClause(u)} AND deleted_at IS NULL`).get(...userArgs(u));
  const ts = now();
  const info = db.prepare(
    `INSERT INTO labels (user_id, name, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(u, clean, color || null, (max.p || 0) + 1, ts, ts);
  return listLabels(u).find(l => l.id === Number(info.lastInsertRowid));
}

export function updateLabel(u, id, { name, color } = {}) {
  const row = db.prepare(`SELECT * FROM labels WHERE id = ? AND ${userClause(u)} AND deleted_at IS NULL`).get(id, ...userArgs(u));
  if (!row) return null;
  const nextName = name !== undefined ? String(name).trim().slice(0, 60) : row.name;
  if (!nextName) return { error: 'Label name required' };
  if (_labelNameTaken(u, nextName, id)) return { error: 'A label with that name already exists' };
  db.prepare(`UPDATE labels SET name = ?, color = ?, updated_at = ? WHERE id = ?`)
    .run(nextName, color !== undefined ? (color || null) : row.color, now(), id);
  return listLabels(u).find(l => l.id === id);
}

export const deleteLabel = db.transaction((u, id) => {
  const row = db.prepare(`SELECT id FROM labels WHERE id = ? AND ${userClause(u)} AND deleted_at IS NULL`).get(id, ...userArgs(u));
  if (!row) return false;
  const ts = now();
  db.prepare(`UPDATE note_labels SET deleted_at = ?, updated_at = ? WHERE label_id = ? AND deleted_at IS NULL`).run(ts, ts, id);
  db.prepare(`UPDATE labels SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, id);
  return true;
});

export const reorderLabels = db.transaction((u, ids = []) => {
  const ts = now();
  const upd = db.prepare(`UPDATE labels SET position = ?, updated_at = ? WHERE id = ? AND ${userClause(u)}`);
  ids.map(Number).filter(Number.isFinite).forEach((id, i) => upd.run(i + 1, ts, id, ...userArgs(u)));
  return listLabels(u);
});
