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
 * Every function takes the signed-in user id `u` (null in single-user
 * mode). A note belongs to its owner (notes.user_id) and can be shared
 * with other accounts through note_members:
 *   - 'edit' members change the title, body, color, and checklist
 *   - 'view' members only read it
 *   - pin, archive, and labels are personal to each person
 *   - reminders, trash, and permanent delete stay with the owner
 */
import { randomUUID } from 'crypto';
import db from '../db.js';
import { dispatchWebhookEvent } from './webhooks.js';
import { cleanLabelIcon } from './label-icons.js';
import { parseWaveform, parseSegments, waveformText, segmentsText } from './voice-meta.js';
import { cleanTaskRepeat, nextDueDate } from './task-rules.js';
import { localParts } from './task-digest-core.js';

export const NOTE_KINDS = new Set(['text', 'checklist']);
export const NOTE_COLORS = new Set(['ember', 'clay', 'amber', 'sand', 'lime', 'moss', 'sage', 'mint', 'sky', 'tide', 'indigo', 'plum', 'orchid', 'rose', 'bark', 'slate']);
export const TRASH_RETENTION_DAYS = 30;
export const REMINDER_REPEATS = new Set(['daily', 'weekly', 'monthly', 'yearly']);
export const MEMBER_ROLES = new Set(['view', 'edit']);

// A new version is only written when the previous one is older than
// this, so one editing session produces one restore point instead of
// one per autosave.
const VERSION_SESSION_MS = 10 * 60 * 1000;
const VERSION_KEEP_PER_NOTE = 50;

const userClause = (u, col = 'user_id') => u == null ? `${col} IS NULL` : `${col} = ?`;
const userArgs   = (u) => u == null ? [] : [u];

/** Server-stamped time with milliseconds, same shape as the sync cursor. */
export function stampNow() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

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
    `SELECT note_id, uuid, text, checked, position, due_date, due_repeat, checked_at FROM checklist_items
      WHERE note_id IN (${ph}) AND deleted_at IS NULL
      ORDER BY position ASC, id ASC`
  ).all(...noteIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.note_id)) map.set(r.note_id, []);
    map.get(r.note_id).push({ uuid: r.uuid, text: r.text, checked: !!r.checked, position: r.position, due_date: r.due_date || null,
      due_repeat: r.due_date ? (r.due_repeat || null) : null, checked_at: r.checked ? (r.checked_at || null) : null });
  }
  return map;
}

function _attachmentsFor(noteIds) {
  if (!noteIds.length) return new Map();
  const ph = noteIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT note_id, uuid, url, mime, name, size_bytes, preview_url, width, height, position, duration_ms, extracted_text, summary, waveform, segments FROM note_attachments
      WHERE note_id IN (${ph}) AND deleted_at IS NULL AND url != ''
      ORDER BY position ASC, id ASC`
  ).all(...noteIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.note_id)) map.set(r.note_id, []);
    map.get(r.note_id).push({ uuid: r.uuid, url: r.url, mime: r.mime, name: r.name || null, size_bytes: r.size_bytes ?? null, preview_url: r.preview_url || null, width: r.width, height: r.height, position: r.position, duration_ms: r.duration_ms, extracted_text: r.extracted_text, summary: r.summary, waveform: parseWaveform(r.waveform), segments: parseSegments(r.segments) });
  }
  return map;
}

function _labelsFor(noteIds, u) {
  if (!noteIds.length) return new Map();
  const ph = noteIds.map(() => '?').join(',');
  // Labels are personal: each person only sees their own on a shared note.
  const rows = db.prepare(
    `SELECT nl.note_id, nl.label_id FROM note_labels nl
       JOIN labels l ON l.id = nl.label_id AND l.deleted_at IS NULL
      WHERE nl.note_id IN (${ph}) AND nl.deleted_at IS NULL AND ${userClause(u, 'nl.user_id')}`
  ).all(...noteIds, ...userArgs(u));
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.note_id)) map.set(r.note_id, []);
    map.get(r.note_id).push(r.label_id);
  }
  return map;
}

function _memberCounts(noteIds) {
  if (!noteIds.length) return new Map();
  const ph = noteIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT note_id, COUNT(*) AS n FROM note_members
      WHERE note_id IN (${ph}) AND deleted_at IS NULL GROUP BY note_id`
  ).all(...noteIds);
  return new Map(rows.map(r => [r.note_id, r.n]));
}

function _ownerNames(userIds) {
  const ids = [...new Set(userIds.filter(x => x != null))];
  if (!ids.length) return new Map();
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, username, full_name FROM users WHERE id IN (${ph})`).all(...ids);
  return new Map(rows.map(r => [r.id, r.full_name || r.username]));
}

/**
 * Share fields for a note row selected through _selectNotes (which joins
 * the caller's membership as m_role / m_pinned / m_archived).
 *   share_role:  'owner' | 'edit' | 'view'
 *   share_owner: the owner's display name when the caller isn't the owner
 *   share_count: people the note is shared with (owner not counted)
 */
function _shareFields(r, counts, owners) {
  const role = r.m_role || 'owner';
  return {
    share_role: role,
    share_owner: role === 'owner' ? null : (owners.get(r.user_id) || null),
    share_count: counts.get(r.id) || 0,
  };
}

function _hydrate(rows, u) {
  const ids = rows.map(r => r.id);
  const items = _itemsFor(ids);
  const labels = _labelsFor(ids, u);
  const attachments = _attachmentsFor(ids);
  const counts = _memberCounts(ids);
  const owners = _ownerNames(rows.filter(r => r.m_role).map(r => r.user_id));
  return rows.map(r => {
    const member = !!r.m_role;
    return {
      id: r.id,
      title: r.title,
      body_md: r.body_md,
      kind: r.kind,
      color: r.color,
      pinned: !!(member ? r.m_pinned : r.pinned),
      in_tasks: !!(member ? r.m_in_tasks : r.in_tasks),
      archived: !!(member ? r.m_archived : r.archived),
      trashed_at: r.trashed_at,
      reminder_at: member ? null : r.reminder_at,
      reminder_rrule: member ? null : r.reminder_rrule,
      reminder_tz: member ? null : r.reminder_tz,
      created_at: r.created_at,
      updated_at: r.updated_at,
      labels: labels.get(r.id) || [],
      items: items.get(r.id) || [],
      attachments: attachments.get(r.id) || [],
      ..._shareFields(r, counts, owners),
    };
  });
}

/**
 * Notes the caller can see, with their membership joined in. Owners see
 * their own notes; members see shared notes that aren't in the owner's
 * trash. Single-user mode has no sharing.
 */
function _selectNotes(u, { join = '', where = [], args = [], order = 'n.updated_at DESC', joinArgs = [] } = {}) {
  if (u == null) {
    return db.prepare(
      `SELECT n.*, NULL AS m_role, NULL AS m_pinned, NULL AS m_archived, NULL AS m_in_tasks FROM notes n${join}
        WHERE n.user_id IS NULL AND n.deleted_at IS NULL${where.length ? ' AND ' + where.join(' AND ') : ''}
        ORDER BY ${order}`
    ).all(...joinArgs, ...args);
  }
  return db.prepare(
    `SELECT n.*, m.role AS m_role, m.pinned AS m_pinned, m.archived AS m_archived, m.in_tasks AS m_in_tasks
       FROM notes n
       LEFT JOIN note_members m ON m.note_id = n.id AND m.user_id = ? AND m.deleted_at IS NULL${join}
      WHERE n.deleted_at IS NULL
        AND (n.user_id = ? OR (m.id IS NOT NULL AND n.trashed_at IS NULL))
        ${where.length ? ' AND ' + where.join(' AND ') : ''}
      ORDER BY ${order}`
  ).all(u, ...joinArgs, u, ...args);
}


/** Turn free text into a safe FTS5 prefix query ("foo bar" → "foo"* "bar"*). */
export function ftsQuery(q) {
  const words = String(q || '').match(/[\p{L}\p{N}]+/gu) || [];
  return words.slice(0, 12).map(w => `"${w}"*`).join(' ');
}

/**
 * List notes for a view.
 *   view: 'notes' (default) | 'archive' | 'trash' | 'reminders' | 'shared' (shared with the caller)
 *   labelId: only notes carrying this label
 *   q: full-text search across title, body and checklist items
 */
export function listNotes(u, { view = 'notes', labelId = null, q = '', kind = null } = {}) {
  const multi = u != null;
  // Pin and archive as the caller sees them: their own, or their membership's.
  const pinned = multi ? '(CASE WHEN m.id IS NULL THEN n.pinned ELSE m.pinned END)' : 'n.pinned';
  const archived = multi ? '(CASE WHEN m.id IS NULL THEN n.archived ELSE m.archived END)' : 'n.archived';
  const owned = multi ? 'm.id IS NULL' : '1';
  const where = [];
  const args = [];
  const joinArgs = [];
  if (view === 'trash') where.push('n.trashed_at IS NOT NULL', owned);
  else if (view === 'reminders') {
    // Reminders belong to the owner.
    where.push('n.trashed_at IS NULL', 'n.reminder_at IS NOT NULL', owned);
  } else if (view === 'shared') {
    where.push('n.trashed_at IS NULL', multi ? 'm.id IS NOT NULL' : '0', `${archived} = 0`);
  } else {
    where.push('n.trashed_at IS NULL');
    where.push(view === 'archive' ? `${archived} = 1` : `${archived} = 0`);
  }
  if (NOTE_KINDS.has(kind)) { where.push('n.kind = ?'); args.push(kind); }
  let join = '';
  if (labelId != null) {
    join += ` JOIN note_labels nl ON nl.note_id = n.id AND nl.deleted_at IS NULL AND nl.label_id = ? AND ${userClause(u, 'nl.user_id')}`;
    joinArgs.push(labelId, ...userArgs(u));
  }
  const match = ftsQuery(q);
  if (match) {
    join += ' JOIN notes_fts f ON f.rowid = n.id';
    where.push('notes_fts MATCH ?');
    args.push(match);
  }
  const order = view === 'notes' ? `${pinned} DESC, n.updated_at DESC`
    : view === 'reminders' ? 'n.reminder_at ASC'
    : 'n.updated_at DESC';
  return _hydrate(_selectNotes(u, { join, where, args, joinArgs, order }), u);
}

/** The note row when the caller owns it (reminders, trash, delete, sharing). */
function _row(u, id) {
  return db.prepare(
    `SELECT * FROM notes WHERE id = ? AND ${userClause(u)} AND deleted_at IS NULL`
  ).get(id, ...userArgs(u));
}

/**
 * The caller's access to a note: { row, role, member } where role is
 * 'owner', 'edit', or 'view'. Null when the note is gone or not theirs.
 */
export function noteAccess(u, id) {
  const row = db.prepare(`SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!row) return null;
  if (u == null ? row.user_id == null : row.user_id === u) return { row, role: 'owner', member: null };
  if (u == null || row.trashed_at) return null;
  const member = db.prepare(
    `SELECT * FROM note_members WHERE note_id = ? AND user_id = ? AND deleted_at IS NULL`
  ).get(id, u);
  return member ? { row, role: member.role, member } : null;
}

/** The note row when the caller may change its content (owner or edit member). */
function _editableRow(u, id) {
  const a = noteAccess(u, id);
  return a && a.role !== 'view' ? a.row : null;
}

export function getNote(u, id) {
  if (id == null) return null;
  return _hydrate(_selectNotes(u, { where: ['n.id = ?'], args: [id] }), u)[0] || null;
}

// ── Versions ─────────────────────────────────────────────────────────

function _itemsJson(noteId) {
  const rows = db.prepare(
    `SELECT uuid, text, checked, position, due_date, due_repeat, checked_at FROM checklist_items
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
  if (!noteAccess(u, noteId)) return null;
  return db.prepare(
    `SELECT id, title, body_md, kind, items_json, reason, created_at
       FROM note_versions WHERE note_id = ? ORDER BY id DESC`
  ).all(noteId).map(v => ({ ...v, items: v.items_json ? JSON.parse(v.items_json) : [], items_json: undefined }));
}

export const restoreVersion = db.transaction((u, noteId, versionId) => {
  const row = _editableRow(u, noteId);
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
    items.forEach((it, i) => _upsertItem(row.user_id, noteId, { text: it.text, checked: it.checked, position: i + 1, due_date: it.due_date, due_repeat: it.due_repeat, checked_at: it.checked_at ?? null }, ts));
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

// Items always carry the note owner's user_id, whoever adds them, so the
// owner's queries and sync see every item on their note.
/** A due date as YYYY-MM-DD, or null. */
export function cleanDueDate(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

function _upsertItem(u, noteId, it, ts) {
  const uuid = typeof it.uuid === 'string' && it.uuid ? it.uuid : randomUUID();
  const due = cleanDueDate(it.due_date);
  db.prepare(
    `INSERT INTO checklist_items (uuid, user_id, note_id, text, checked, position, due_date, due_repeat, checked_at, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(uuid) DO UPDATE SET
       text = excluded.text, checked = excluded.checked, position = excluded.position,
       due_date = excluded.due_date, due_repeat = excluded.due_repeat, checked_at = excluded.checked_at,
       updated_at = excluded.updated_at, deleted_at = NULL
     WHERE checklist_items.note_id = excluded.note_id`
  ).run(uuid, u, noteId, String(it.text ?? '').slice(0, 5000), it.checked ? 1 : 0,
        Number.isFinite(+it.position) ? +it.position : 0, due,
        due ? cleanTaskRepeat(it.due_repeat) : null,
        // Ticked just now unless told otherwise; null keeps an imported tick undated
        // so old ticks don't crowd the Completed list.
        it.checked ? (typeof it.checked_at === 'string' && it.checked_at ? it.checked_at.slice(0, 30) : (it.checked_at === null ? null : stampNow())) : null,
        ts, ts);
  return uuid;
}

/** The caller's calendar day: the one the client says, else their saved time zone's, else the server's. */
function _today(u, claimed) {
  if (cleanDueDate(claimed)) return claimed;
  try {
    const r = db.prepare(`SELECT value FROM user_settings WHERE user_id IS ? AND key = 'timezone' AND deleted_at IS NULL`).get(u ?? null);
    let tz = null;
    try { tz = r ? JSON.parse(r.value) : null; } catch { tz = r?.value || null; }
    return localParts(new Date(), tz).date;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export const createNote = db.transaction((u, data = {}) => {
  const ts = now();
  const kind = NOTE_KINDS.has(data.kind) ? data.kind : 'text';
  const info = db.prepare(
    `INSERT INTO notes (user_id, title, body_md, kind, color, pinned, archived, in_tasks,
                        reminder_at, reminder_rrule, reminder_tz, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(u, _cleanTitle(data.title), kind === 'text' ? _cleanBody(data.body_md) : '',
        kind, _cleanColor(data.color), data.pinned ? 1 : 0, data.archived ? 1 : 0, data.in_tasks ? 1 : 0,
        _cleanReminderAt(data.reminder_at), _cleanRepeat(data.reminder_rrule), _cleanTz(data.reminder_tz), ts, ts);
  const id = Number(info.lastInsertRowid);
  if (kind === 'checklist' && Array.isArray(data.items)) {
    data.items.forEach((it, i) => _upsertItem(u, id, { ...it, position: it.position ?? i + 1 }, ts));
  }
  if (Array.isArray(data.labels)) _setLabels(u, id, data.labels, ts);
  _addAttachments(u, id, data.attachments, ts);
  const note = getNote(u, id);
  _emit(u, 'note.created', { note_id: id, title: note.title, kind: note.kind });
  return note;
});

/** Partial update. Only fields present in `patch` change. */
export const updateNote = db.transaction((u, id, patch = {}) => {
  const access = noteAccess(u, id);
  if (!access) return null;
  if (access.role !== 'owner') return _updateAsMember(u, access, patch);
  const row = access.row;
  const sets = [];
  const args = [];
  const contentChanging =
    ('title' in patch && _cleanTitle(patch.title) !== row.title) ||
    ('body_md' in patch && _cleanBody(patch.body_md) !== row.body_md);
  // snapshot: 'restore' always keeps a version (a whole-text rewrite by Trace).
  if (contentChanging) snapshotVersion(row, patch.snapshot === 'restore' ? 'restore' : 'edit');
  if ('title' in patch)   { sets.push('title = ?');   args.push(_cleanTitle(patch.title)); }
  if ('body_md' in patch) { sets.push('body_md = ?'); args.push(_cleanBody(patch.body_md)); }
  if ('color' in patch)   { sets.push('color = ?');   args.push(_cleanColor(patch.color)); }
  if ('pinned' in patch)  { sets.push('pinned = ?');  args.push(patch.pinned ? 1 : 0); }
  if ('in_tasks' in patch) { sets.push('in_tasks = ?'); args.push(patch.in_tasks ? 1 : 0); }
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
  if ('title' in patch && patch.rename_links !== false) _renameLinks(row.user_id, id, patch.rename_links_from != null ? _cleanTitle(patch.rename_links_from) : row.title, _cleanTitle(patch.title), ts);
  return getNote(u, id);
});

// A member's patch: pin, archive, and labels are theirs; content changes
// need 'edit'; reminders and trash aren't theirs to change.
function _updateAsMember(u, { row, role, member }, patch) {
  const id = row.id;
  const ts = now();
  const mine = [];
  const mineArgs = [];
  if ('pinned' in patch) { mine.push('pinned = ?'); mineArgs.push(patch.pinned ? 1 : 0); }
  if ('in_tasks' in patch) { mine.push('in_tasks = ?'); mineArgs.push(patch.in_tasks ? 1 : 0); }
  if ('archived' in patch) {
    mine.push('archived = ?'); mineArgs.push(patch.archived ? 1 : 0);
    if (patch.archived) mine.push('pinned = 0');
  }
  if (mine.length) {
    db.prepare(`UPDATE note_members SET ${mine.join(', ')}, updated_at = ? WHERE id = ?`).run(...mineArgs, stampNow(), member.id);
    restampNote(id);
  }
  if (role === 'edit') {
    const sets = [];
    const args = [];
    const contentChanging =
      ('title' in patch && _cleanTitle(patch.title) !== row.title) ||
      ('body_md' in patch && _cleanBody(patch.body_md) !== row.body_md);
    if (contentChanging) snapshotVersion(row, patch.snapshot === 'restore' ? 'restore' : 'edit');
    if ('title' in patch)   { sets.push('title = ?');   args.push(_cleanTitle(patch.title)); }
    if ('body_md' in patch) { sets.push('body_md = ?'); args.push(_cleanBody(patch.body_md)); }
    if ('color' in patch)   { sets.push('color = ?');   args.push(_cleanColor(patch.color)); }
    if (sets.length) db.prepare(`UPDATE notes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, ts, id);
    if ('title' in patch && patch.rename_links !== false) _renameLinks(row.user_id, id, patch.rename_links_from != null ? _cleanTitle(patch.rename_links_from) : row.title, _cleanTitle(patch.title), ts);
  }
  if (Array.isArray(patch.labels)) _setLabels(u, id, patch.labels, ts);
  return getNote(u, id);
}

/**
 * Bump a note's sync cursor (and its items') without changing its
 * content, so every device that can see it pulls it again: used when
 * sharing changes who sees it or how.
 */
export function restampNote(noteId) {
  const stamp = stampNow();
  db.prepare(`UPDATE notes SET synced_at = ? WHERE id = ?`).run(stamp, noteId);
  db.prepare(`UPDATE checklist_items SET synced_at = ? WHERE note_id = ?`).run(stamp, noteId);
  db.prepare(`UPDATE note_attachments SET synced_at = ? WHERE note_id = ?`).run(stamp, noteId);
}

/** Switch a note between text and checklist without losing content. */
export const convertNote = db.transaction((u, id, kind) => {
  const row = _editableRow(u, id);
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
    lines.forEach((it, i) => _upsertItem(row.user_id, id, { ...it, position: i + 1, checked_at: null }, ts));
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
  db.prepare(`UPDATE note_attachments SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND deleted_at IS NULL`).run(ts, ts, id);
  db.prepare(`UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, id);
  db.prepare(`UPDATE note_members SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND deleted_at IS NULL`).run(stampNow(), stampNow(), id);
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
  const row = _editableRow(u, noteId);
  if (!row || row.kind !== 'checklist') return null;
  const ts = now();
  let position = Number(data.position);
  if (!Number.isFinite(position)) {
    const max = db.prepare(`SELECT MAX(position) AS p FROM checklist_items WHERE note_id = ? AND deleted_at IS NULL`).get(noteId);
    position = (max.p || 0) + 1;
  }
  _upsertItem(row.user_id, noteId, { uuid: data.uuid, text: data.text, checked: data.checked, position, due_date: data.due_date, due_repeat: data.due_repeat }, ts);
  _touch(noteId, ts);
  return getNote(u, noteId);
});

export const updateItem = db.transaction((u, noteId, uuid, patch = {}) => {
  const row = _editableRow(u, noteId);
  if (!row) return null;
  const item = db.prepare(`SELECT * FROM checklist_items WHERE uuid = ? AND note_id = ? AND deleted_at IS NULL`).get(uuid, noteId);
  if (!item) return null;
  const wasComplete = _checklistCompleted(noteId);
  const ts = now();
  let checked = 'checked' in patch ? !!patch.checked : !!item.checked;
  let dueDate = 'due_date' in patch ? patch.due_date : item.due_date;
  const repeat = 'due_repeat' in patch ? patch.due_repeat : item.due_repeat;
  // Ticking a repeating task moves it to its next date and leaves it open.
  if (checked && !item.checked && cleanTaskRepeat(repeat) && cleanDueDate(dueDate)) {
    dueDate = nextDueDate(dueDate, repeat, _today(u, patch.today));
    checked = false;
  }
  _upsertItem(row.user_id, noteId, {
    uuid,
    text: 'text' in patch ? patch.text : item.text,
    checked,
    position: 'position' in patch ? patch.position : item.position,
    due_date: dueDate,
    due_repeat: repeat,
    checked_at: checked ? (item.checked ? item.checked_at : undefined) : null,
  }, ts);
  _touch(noteId, ts);
  if (!wasComplete && _checklistCompleted(noteId)) {
    _emit(row.user_id, 'checklist.completed', { note_id: noteId, title: row.title });
  }
  return getNote(u, noteId);
});

export const deleteItem = db.transaction((u, noteId, uuid) => {
  const row = _editableRow(u, noteId);
  if (!row) return null;
  const ts = now();
  db.prepare(`UPDATE checklist_items SET deleted_at = ?, updated_at = ? WHERE uuid = ? AND note_id = ?`).run(ts, ts, uuid, noteId);
  _touch(noteId, ts);
  return getNote(u, noteId);
});

/** Set item order from a list of uuids. Items not listed keep their position. */
export const reorderItems = db.transaction((u, noteId, uuids = []) => {
  const row = _editableRow(u, noteId);
  if (!row) return null;
  const ts = now();
  const upd = db.prepare(`UPDATE checklist_items SET position = ?, updated_at = ? WHERE uuid = ? AND note_id = ? AND deleted_at IS NULL`);
  uuids.forEach((uuid, i) => upd.run(i + 1, ts, uuid, noteId));
  _touch(noteId, ts);
  return getNote(u, noteId);
});

// ── Attachments ──────────────────────────────────────────────────────

export const ATTACHMENTS_MAX_PER_NOTE = 50;

/** A file's name for showing: no folders, no control characters, at most 255 characters. */
export function cleanFileName(v) {
  if (typeof v !== 'string') return null;
  const base = v.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base ? base.slice(0, 255) : null;
}

/** Only files this server stored (or a data-free relative uploads path) may be attached. */
export function cleanAttachmentUrl(v) {
  const s = String(v ?? '').trim();
  return /^\/?uploads\/[A-Za-z0-9._-]+$/.test(s) ? (s.startsWith('/') ? s : `/${s}`) : null;
}

function _addAttachments(ownerOrU, noteId, list, ts) {
  if (!Array.isArray(list)) return 0;
  const owner = db.prepare(`SELECT user_id FROM notes WHERE id = ?`).get(noteId)?.user_id ?? ownerOrU;
  const count = db.prepare(`SELECT COUNT(*) AS n FROM note_attachments WHERE note_id = ? AND deleted_at IS NULL`).get(noteId).n;
  const max = db.prepare(`SELECT MAX(position) AS p FROM note_attachments WHERE note_id = ? AND deleted_at IS NULL`).get(noteId).p || 0;
  let added = 0;
  for (const a of list.slice(0, Math.max(0, ATTACHMENTS_MAX_PER_NOTE - count))) {
    const url = cleanAttachmentUrl(a?.url);
    if (!url) continue;
    const uuid = typeof a.uuid === 'string' && a.uuid ? a.uuid.slice(0, 64) : randomUUID();
    const num = v => (Number.isFinite(+v) && +v > 0 ? Math.round(+v) : null);
    db.prepare(
      `INSERT INTO note_attachments (uuid, user_id, note_id, url, mime, name, size_bytes, preview_url, width, height, position, duration_ms, extracted_text, summary, waveform, segments, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET deleted_at = NULL, updated_at = excluded.updated_at
       WHERE note_attachments.note_id = excluded.note_id`
    ).run(uuid, owner, noteId, url, typeof a.mime === 'string' ? a.mime.slice(0, 100) : null,
          cleanFileName(a.name), num(a.size_bytes), cleanAttachmentUrl(a.preview_url),
          num(a.width), num(a.height), max + added + 1, num(a.duration_ms),
          typeof a.extracted_text === 'string' && a.extracted_text.trim() ? a.extracted_text.slice(0, 50000) : null,
          typeof a.summary === 'string' && a.summary.trim() ? a.summary.slice(0, 8000) : null,
          waveformText(a.waveform), segmentsText(a.segments), ts, ts);
    added++;
  }
  return added;
}

/** Add images to a note (owner or edit member). */
export const addAttachments = db.transaction((u, noteId, list) => {
  const row = _editableRow(u, noteId);
  if (!row) return null;
  const ts = now();
  if (_addAttachments(u, noteId, list, ts)) _touch(noteId, ts);
  return getNote(u, noteId);
});

/** Save a voice note's transcript, summary, timestamps, or waveform, or an image's text (owner or edit member). */
export const updateAttachment = db.transaction((u, noteId, uuid, patch = {}) => {
  const row = _editableRow(u, noteId);
  if (!row) return null;
  const sets = [];
  const args = [];
  if ('extracted_text' in patch) { sets.push('extracted_text = ?'); args.push(typeof patch.extracted_text === 'string' ? patch.extracted_text.slice(0, 50000) : null); }
  if ('preview_url' in patch) { sets.push('preview_url = ?'); args.push(cleanAttachmentUrl(patch.preview_url)); }
  if ('summary' in patch) { sets.push('summary = ?'); args.push(typeof patch.summary === 'string' && patch.summary.trim() ? patch.summary.slice(0, 8000) : null); }
  if ('waveform' in patch) { sets.push('waveform = ?'); args.push(waveformText(patch.waveform)); }
  if ('segments' in patch) { sets.push('segments = ?'); args.push(segmentsText(patch.segments)); }
  if (!sets.length) return getNote(u, noteId);
  const r = db.prepare(`UPDATE note_attachments SET ${sets.join(', ')}, updated_at = ? WHERE uuid = ? AND note_id = ? AND deleted_at IS NULL`)
    .run(...args, now(), uuid, noteId);
  return r.changes ? getNote(u, noteId) : null;
});

export const deleteAttachment = db.transaction((u, noteId, uuid) => {
  const row = _editableRow(u, noteId);
  if (!row) return null;
  const ts = now();
  const r = db.prepare(`UPDATE note_attachments SET deleted_at = ?, updated_at = ? WHERE uuid = ? AND note_id = ? AND deleted_at IS NULL`)
    .run(ts, ts, uuid, noteId);
  if (r.changes) _touch(noteId, ts);
  return getNote(u, noteId);
});

// ── Labels ───────────────────────────────────────────────────────────

function _setLabels(u, noteId, labelIds, ts) {
  const wanted = new Set(labelIds.map(Number).filter(Number.isFinite));
  const owned = new Set(db.prepare(
    `SELECT id FROM labels WHERE ${userClause(u)} AND deleted_at IS NULL`
  ).all(...userArgs(u)).map(r => r.id));
  const existing = db.prepare(
    `SELECT label_id, deleted_at FROM note_labels WHERE note_id = ? AND ${userClause(u)}`
  ).all(noteId, ...userArgs(u));
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
    db.prepare(`UPDATE note_labels SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND label_id = ? AND ${userClause(u)}`)
      .run(ts, ts, noteId, lid, ...userArgs(u));
  }
}

export function listLabels(u) {
  return db.prepare(
    `SELECT l.id, l.name, l.color, l.icon, l.position, l.created_at, l.updated_at,
            (SELECT COUNT(*) FROM note_labels nl JOIN notes n ON n.id = nl.note_id
              WHERE nl.label_id = l.id AND nl.deleted_at IS NULL
                AND n.deleted_at IS NULL AND n.trashed_at IS NULL
                AND (n.user_id IS l.user_id OR EXISTS (
                  SELECT 1 FROM note_members m WHERE m.note_id = n.id AND m.user_id = l.user_id AND m.deleted_at IS NULL))) AS note_count
       FROM labels l WHERE ${userClause(u, 'l.user_id')} AND l.deleted_at IS NULL
      ORDER BY l.position ASC, l.name COLLATE NOCASE ASC`
  ).all(...userArgs(u));
}

function _labelNameTaken(u, name, exceptId = null) {
  return !!db.prepare(
    `SELECT 1 FROM labels WHERE ${userClause(u)} AND deleted_at IS NULL AND name = ? COLLATE NOCASE AND id IS NOT ?`
  ).get(...userArgs(u), name, exceptId);
}

export function createLabel(u, { name, color, icon } = {}) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return { error: 'Label name required' };
  if (_labelNameTaken(u, clean)) return { error: 'A label with that name already exists' };
  const max = db.prepare(`SELECT MAX(position) AS p FROM labels WHERE ${userClause(u)} AND deleted_at IS NULL`).get(...userArgs(u));
  const ts = now();
  const info = db.prepare(
    `INSERT INTO labels (user_id, name, color, icon, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(u, clean, color || null, cleanLabelIcon(icon), (max.p || 0) + 1, ts, ts);
  return listLabels(u).find(l => l.id === Number(info.lastInsertRowid));
}

export function updateLabel(u, id, { name, color, icon } = {}) {
  const row = db.prepare(`SELECT * FROM labels WHERE id = ? AND ${userClause(u)} AND deleted_at IS NULL`).get(id, ...userArgs(u));
  if (!row) return null;
  const nextName = name !== undefined ? String(name).trim().slice(0, 60) : row.name;
  if (!nextName) return { error: 'Label name required' };
  if (_labelNameTaken(u, nextName, id)) return { error: 'A label with that name already exists' };
  db.prepare(`UPDATE labels SET name = ?, color = ?, icon = ?, updated_at = ? WHERE id = ?`)
    .run(nextName, color !== undefined ? (color || null) : row.color, icon !== undefined ? cleanLabelIcon(icon) : row.icon, now(), id);
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

// ── Sharing ──────────────────────────────────────────────────────────

/**
 * Owner and members of a note, for anyone who can see it.
 * Returns null when the caller has no access.
 */
export function listMembers(u, noteId) {
  const access = noteAccess(u, noteId);
  if (!access || u == null) return null;
  const owner = db.prepare(`SELECT id, username, full_name FROM users WHERE id = ?`).get(access.row.user_id);
  const members = db.prepare(
    `SELECT m.user_id, m.role, m.created_at, u.username, u.full_name
       FROM note_members m JOIN users u ON u.id = m.user_id
      WHERE m.note_id = ? AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC, m.id ASC`
  ).all(noteId);
  return {
    role: access.role,
    owner: owner ? { user_id: owner.id, username: owner.username, full_name: owner.full_name } : null,
    members,
  };
}

/** Owner shares a note with another account by username or email. */
export const addMember = db.transaction((u, noteId, { username, role = 'edit' } = {}) => {
  if (u == null) return { status: 400, error: 'Sharing needs user accounts' };
  const row = _row(u, noteId);
  if (!row) return { status: 404, error: 'Note not found' };
  if (row.trashed_at) return { status: 400, error: 'Restore the note before sharing it' };
  const who = String(username || '').trim();
  if (!who) return { status: 400, error: 'Username required' };
  const target = db.prepare(
    `SELECT id FROM users WHERE username = ? COLLATE NOCASE OR (email IS NOT NULL AND email = ? COLLATE NOCASE)`
  ).get(who, who);
  if (!target) return { status: 404, error: 'No account with that username or email' };
  if (target.id === u) return { status: 400, error: 'You already own this note' };
  const cleanRole = MEMBER_ROLES.has(role) ? role : 'edit';
  const stamp = stampNow();
  db.prepare(
    `INSERT INTO note_members (note_id, user_id, role, added_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(note_id, user_id) DO UPDATE SET
       role = excluded.role, updated_at = excluded.updated_at, deleted_at = NULL,
       pinned = CASE WHEN note_members.deleted_at IS NULL THEN note_members.pinned ELSE 0 END,
       archived = CASE WHEN note_members.deleted_at IS NULL THEN note_members.archived ELSE 0 END,
       in_tasks = CASE WHEN note_members.deleted_at IS NULL THEN note_members.in_tasks ELSE 0 END`
  ).run(noteId, target.id, cleanRole, u, now(), stamp);
  restampNote(noteId);
  return { ok: true, ...listMembers(u, noteId) };
});

export function updateMember(u, noteId, memberUserId, { role } = {}) {
  if (u == null || !_row(u, noteId)) return { status: 404, error: 'Note not found' };
  if (!MEMBER_ROLES.has(role)) return { status: 400, error: 'role must be view or edit' };
  const r = db.prepare(
    `UPDATE note_members SET role = ?, updated_at = ? WHERE note_id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(role, stampNow(), noteId, memberUserId);
  if (!r.changes) return { status: 404, error: 'Not shared with that person' };
  restampNote(noteId);
  return { ok: true, ...listMembers(u, noteId) };
}

/**
 * The owner removes a member, or a member leaves. Their labels on the
 * note are removed with them.
 */
export const removeMember = db.transaction((u, noteId, memberUserId) => {
  if (u == null) return { status: 404, error: 'Note not found' };
  const access = noteAccess(u, noteId);
  const isOwner = access?.role === 'owner';
  if (!access || (!isOwner && memberUserId !== u)) return { status: 404, error: 'Note not found' };
  const stamp = stampNow();
  const r = db.prepare(
    `UPDATE note_members SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(stamp, stamp, noteId, memberUserId);
  if (!r.changes) return { status: 404, error: 'Not shared with that person' };
  const ts = now();
  db.prepare(`UPDATE note_labels SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND user_id = ? AND deleted_at IS NULL`)
    .run(ts, ts, noteId, memberUserId);
  restampNote(noteId);
  return isOwner ? { ok: true, ...listMembers(u, noteId) } : { ok: true };
});

/**
 * Server ids of shared notes this user should drop from their devices:
 * memberships removed, or the owner moved the note to trash, since the
 * given sync cursor.
 */
export function revokedNoteIds(u, since) {
  if (u == null) return [];
  return db.prepare(
    `SELECT DISTINCT m.note_id AS id FROM note_members m JOIN notes n ON n.id = m.note_id
      WHERE m.user_id = ?
        AND ((m.deleted_at IS NOT NULL AND m.updated_at >= ?)
          OR (m.deleted_at IS NULL AND n.trashed_at IS NOT NULL AND n.synced_at >= ?))`
  ).all(u, since, since).map(r => r.id);
}

// ── Import ───────────────────────────────────────────────────────────

export const IMPORT_BATCH_MAX = 500;

function _cleanTs(v) {
  if (v == null || v === '') return null;
  const ms = tsMs(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : null;
}

/**
 * Import already-parsed notes (see src/lib/import-export) keeping their
 * original dates. Labels are matched by name, created when missing. A
 * note identical to one already here (same title, kind, body, and
 * created time) is skipped, so importing the same export twice doesn't
 * duplicate anything. No webhooks fire for imports.
 */
export const importNotes = db.transaction((u, list = []) => {
  // ids[i] is the new note's id, or null when list[i] was skipped, so the
  // client only uploads images for notes that were actually created.
  const result = { imported: 0, skipped: 0, labels_created: 0, ids: [] };
  const labelIds = new Map(listLabels(u).map(l => [l.name.toLowerCase(), l.id]));
  const ts = now();
  for (const raw of list.slice(0, IMPORT_BATCH_MAX)) {
    result.ids.push(null);
    if (!raw || typeof raw !== 'object') { result.skipped++; continue; }
    const kind = NOTE_KINDS.has(raw.kind) ? raw.kind : 'text';
    const title = _cleanTitle(raw.title);
    const body = kind === 'text' ? _cleanBody(raw.body_md) : '';
    const items = kind === 'checklist' && Array.isArray(raw.items)
      ? raw.items.filter(i => i && String(i.text ?? '').trim()).slice(0, 2000)
      : [];
    const hasImages = Array.isArray(raw.files) && raw.files.length > 0;
    if (!title && !body.trim() && !items.length && !hasImages) { result.skipped++; continue; }
    const created = _cleanTs(raw.created_at) || ts;
    const updated = _cleanTs(raw.updated_at) || created;
    // A note with only images has nothing to compare but its date, so it's
    // only treated as a repeat when the source gave it a real one.
    const imageOnly = !title && !body.trim() && !items.length;
    const dup = !(imageOnly && !_cleanTs(raw.created_at)) && db.prepare(
      `SELECT 1 FROM notes WHERE ${userClause(u)} AND deleted_at IS NULL
         AND title = ? AND kind = ? AND body_md = ? AND created_at = ? LIMIT 1`
    ).get(...userArgs(u), title, kind, body, created);
    if (dup) { result.skipped++; continue; }

    const reminderAt = _cleanReminderAt(raw.reminder_at);
    const info = db.prepare(
      `INSERT INTO notes (user_id, title, body_md, kind, color, pinned, archived, in_tasks, trashed_at,
                          reminder_at, reminder_rrule, reminder_tz, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(u, title, body, kind, _cleanColor(raw.color),
          raw.pinned && !raw.archived && !raw.trashed ? 1 : 0, raw.archived ? 1 : 0, kind === 'checklist' && raw.in_tasks ? 1 : 0,
          raw.trashed ? ts : null,
          reminderAt, reminderAt ? _cleanRepeat(raw.reminder_rrule) : null, reminderAt ? _cleanTz(raw.reminder_tz) : null,
          created, updated);
    const id = Number(info.lastInsertRowid);
    items.forEach((it, i) => _upsertItem(u, id, { text: it.text, checked: !!it.checked, position: i + 1, checked_at: null }, updated));

    const ids = [];
    for (const name of Array.isArray(raw.labels) ? raw.labels : []) {
      const clean = String(name ?? '').trim().slice(0, 60);
      if (!clean) continue;
      let lid = labelIds.get(clean.toLowerCase());
      if (!lid) {
        const label = createLabel(u, { name: clean });
        if (!label || label.error) continue;
        lid = label.id;
        labelIds.set(clean.toLowerCase(), lid);
        result.labels_created++;
      }
      ids.push(lid);
    }
    if (ids.length) _setLabels(u, id, ids, updated);
    _addAttachments(u, id, raw.attachments, updated);
    result.ids[result.ids.length - 1] = id;
    result.imported++;
  }
  return result;
});

// ── Links ([[Note title]]) ───────────────────────────────────────────

const _escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How many open checklist items due by `today` (YYYY-MM-DD) the caller can
 * see, for the Tasks badge in the sidebar. Counted here so a badge doesn't
 * cost a fetch of the whole library every time a note changes.
 */
export function tasksDueCount(u, today) {
  const day = cleanDueDate(today) || stampNow().slice(0, 10);
  const item = `ci.deleted_at IS NULL AND ci.checked = 0 AND ci.due_date IS NOT NULL
                  AND ci.due_date <= ? AND trim(ci.text) != ''`;
  const note = `n.deleted_at IS NULL AND n.trashed_at IS NULL AND n.kind = 'checklist'`;
  const row = u == null
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM checklist_items ci JOIN notes n ON n.id = ci.note_id AND ${note}
          WHERE ${item} AND n.user_id IS NULL AND n.archived = 0`
      ).get(day)
    : db.prepare(
        `SELECT COUNT(*) AS n FROM checklist_items ci
           JOIN notes n ON n.id = ci.note_id AND ${note}
           LEFT JOIN note_members m ON m.note_id = n.id AND m.user_id = ? AND m.deleted_at IS NULL
          WHERE ${item} AND (n.user_id = ? OR m.id IS NOT NULL)
            AND (CASE WHEN m.id IS NULL THEN n.archived ELSE m.archived END) = 0`
      ).get(u, day, u);
  return { tasksDue: row?.n || 0, today: day };
}

/** Titled notes the caller can see, for link suggestions. */
export function listNoteTitles(u) {
  return _selectNotes(u, { where: ["n.trashed_at IS NULL", "n.title != ''"], order: 'n.updated_at DESC' })
    .map(r => ({ id: r.id, title: r.title }));
}

/** The note a [[title]] points at: an exact title match (ignoring case), active notes before archived ones. */
export function findNoteByTitle(u, title) {
  const t = String(title || '').trim();
  if (!t) return null;
  const rows = _selectNotes(u, { where: ['n.trashed_at IS NULL', 'lower(trim(n.title)) = lower(?)'], args: [t], order: 'n.archived ASC, n.updated_at DESC' });
  return rows.length ? _hydrate(rows.slice(0, 1), u)[0] : null;
}

/** Notes that link to this one ("Linked From"). */
export function listBacklinks(u, noteId) {
  const access = noteAccess(u, noteId);
  const title = access?.row?.title?.trim();
  if (!access || !title) return access ? [] : null;
  const re = new RegExp(`\\[\\[\\s*${_escapeRe(title)}\\s*\\]\\]`, 'i');
  return _selectNotes(u, { where: ['n.id != ?', 'n.trashed_at IS NULL', "instr(lower(n.body_md), lower(?)) > 0"], args: [noteId, title], order: 'n.updated_at DESC' })
    .filter(r => re.test(r.body_md))
    .map(r => ({ id: r.id, title: r.title, kind: r.kind, archived: !!(r.m_role ? r.m_archived : r.archived) }));
}

/**
 * Renaming a note keeps links to it working: [[Old title]] in the owner's
 * other notes becomes [[New title]]. Other people's notes aren't touched.
 */
function _renameLinks(ownerId, noteId, oldTitle, newTitle, ts) {
  const from = String(oldTitle || '').trim();
  const to = String(newTitle || '').trim();
  if (!from || !to || from === to) return 0;
  // Another note with either title owns those links: leave them alone.
  const clash = db.prepare(
    `SELECT 1 FROM notes WHERE user_id IS ? AND id != ? AND deleted_at IS NULL AND lower(trim(title)) IN (lower(?), lower(?)) LIMIT 1`
  ).get(ownerId ?? null, noteId, from, to);
  if (clash) return 0;
  const re = new RegExp(`\\[\\[\\s*${_escapeRe(from)}\\s*\\]\\]`, 'gi');
  const rows = db.prepare(
    `SELECT id, body_md FROM notes WHERE user_id IS ? AND id != ? AND deleted_at IS NULL AND instr(lower(body_md), lower(?)) > 0`
  ).all(ownerId ?? null, noteId, from);
  let changed = 0;
  for (const r of rows) {
    const next = r.body_md.replace(re, () => `[[${to}]]`);
    if (next === r.body_md) continue;
    db.prepare(`UPDATE notes SET body_md = ?, updated_at = ? WHERE id = ?`).run(next, ts, r.id);
    changed++;
  }
  return changed;
}
