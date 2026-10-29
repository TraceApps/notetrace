/**
 * notes.js: REST routes for notes, checklist items, and versions.
 * Thin layer over server/lib/notes.js, which owns the rules.
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import * as Notes from '../lib/notes.js';
import { plainExcerpt } from '../lib/note-excerpt.js';
import { mergeEdit, rowTimes, instantMs, stampTimes, fieldUnits } from '../lib/field-sync.js';
import { SYNC_FIELDS, SYNC_GROUPS, SYNC_JSON } from '../lib/sync-fields.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const idParam = req => {
  const n = parseInt(req.params.id, 10);
  return Number.isFinite(n) ? n : null;
};
const notFound = res => res.status(404).json({ error: 'Note not found' });

// GET /api/notes?view=notes|archive|trash|reminders|shared&label=<id>&q=<text>
/**
 * The notes a user chose to keep on their watch, or null for all of them.
 * Stored by the app as the `watchNotes` setting: a list of note ids.
 */
function watchChoice(req) {
  const u = uid(req);
  if (u == null) return null;
  const row = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'watchNotes' AND deleted_at IS NULL").get(u);
  if (!row?.value) return null;
  try {
    const ids = JSON.parse(row.value);
    return Array.isArray(ids) && ids.length ? new Set(ids.map(Number)) : null;
  } catch { return null; }
}

router.get('/', wrap((req, res) => {
  const view = ['notes', 'archive', 'trash', 'reminders', 'shared'].includes(req.query.view) ? req.query.view : 'notes';
  const label = parseInt(req.query.label, 10);
  const notes = Notes.listNotes(uid(req), {
    view,
    labelId: Number.isFinite(label) ? label : null,
    q: typeof req.query.q === 'string' ? req.query.q : '',
    kind: typeof req.query.kind === 'string' ? req.query.kind : null,
  });
  // slim=1: what a watch needs and nothing else. Note bodies, attachments,
  // labels and previews are most of the payload and none of them fit on a
  // 1.2 inch screen, and the connection they arrive over is slow.
  if (req.query.slim === '1') {
    // watch=1: only what the user chose to keep on the watch, when they chose.
    // A watch with a hundred notes on it is a list nobody scrolls.
    const chosen = req.query.watch === '1' ? watchChoice(req) : null;
    const wanted = chosen ? notes.filter(n => chosen.has(n.id)) : notes;
    return res.json(wanted.map(n => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      updated_at: n.updated_at,
      pinned: !!n.pinned,
      // Read Only (TraceApps/notetrace#30): the watch ticks its items but adds none.
      read_only: !!n.read_only,
      reminder_at: n.reminder_at || null,
      reminder_rrule: n.reminder_rrule || null,
      // Enough of a text note to read on a wrist, with the Markdown marks
      // taken out; the phone has the whole thing.
      excerpt: n.kind === 'checklist' ? '' : plainExcerpt(n.body_md, 1200),
      items: (n.items || []).map(i => ({ uuid: i.uuid, text: i.text, checked: !!i.checked })),
    })));
  }
  res.json(notes);
}));

router.post('/', wrap((req, res) => {
  res.status(201).json(Notes.createNote(uid(req), req.body || {}));
}));

// Import parsed notes (Google Keep, Markdown). Body: { notes: [...] }, at
// most IMPORT_BATCH_MAX per request; the client sends larger imports in batches.
router.post('/import', wrap((req, res) => {
  const list = req.body?.notes;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'notes must be an array' });
  if (list.length > Notes.IMPORT_BATCH_MAX) return res.status(413).json({ error: `At most ${Notes.IMPORT_BATCH_MAX} notes per request` });
  res.json(Notes.importNotes(uid(req), list));
}));

// Counts for the sidebar, so a badge doesn't need the whole library.
// ?today=YYYY-MM-DD is the caller's own date.
router.get('/counts', wrap((req, res) => {
  res.json(Notes.tasksDueCount(uid(req), req.query.today));
}));

// Link helpers. Registered before /:id routes.
router.get('/titles', wrap((req, res) => { res.json(Notes.listNoteTitles(uid(req))); }));
router.get('/by-title', wrap((req, res) => {
  const note = Notes.findNoteByTitle(uid(req), typeof req.query.title === 'string' ? req.query.title : '');
  return note ? res.json(note) : notFound(res);
}));

// Empty trash. Registered before /:id routes so "trash" never parses as an id.
router.delete('/trash', wrap((req, res) => {
  res.json({ deleted: Notes.emptyTrash(uid(req)) });
}));

router.get('/:id', wrap((req, res) => {
  const note = Notes.getNote(uid(req), idParam(req));
  return note ? res.json(note) : notFound(res);
}));

/**
 * A change sent with when it was made (edited_at, ISO 8601 with its zone,
 * on the sender's clock; client_now, the sender's clock as it sent it): a
 * change queued with no connection (the watch) and sent later. Of the
 * fields it changes, the ones changed here after it was made stay as they
 * are (lib/field-sync.js): the patch goes without them. A change that
 * doesn't say was made now, as always. Servers from before ignore both.
 */
function _madeBefore(req, table, row, patch) {
  const sent = instantMs(patch?.edited_at);
  const { edited_at: _e, client_now: _c, ...rest } = patch || {};
  const none = { body: rest, stamp: null };
  if (!row || !Number.isFinite(sent) || typeof patch.edited_at !== 'string' || !/(Z|[+-]\d\d:?\d\d)$/i.test(patch.edited_at.trim())) return none;
  const arrived = req.receivedAt || Date.now();
  // Put on this clock by the sender's clock as it sent it. Without that
  // (or with a clock no real one is, a year or more out), the change counts
  // as made now, as one that doesn't say.
  const theirs = instantMs(patch.client_now);
  if (!Number.isFinite(theirs) || Math.abs(arrived - theirs) >= 366 * 86400000) return none;
  const at = Math.min(sent + (arrived - theirs), arrived);
  const fields = SYNC_FIELDS[table].filter(f => f in rest);
  if (!fields.length) return none;
  const m = mergeEdit({
    existing: row, values: Object.fromEntries(fields.map(f => [f, rest[f]])), fields: SYNC_FIELDS[table],
    groups: SYNC_GROUPS[table], json: SYNC_JSON[table], changed: fields, at, times: rowTimes(row),
  });
  for (const f of m.lost) delete rest[f];
  // What goes in counts from when it was made, not from when it arrived.
  // A group's other fields too (an item's checked_at, which the write sets
  // itself): the group stays one edit, made then.
  const won = fieldUnits(SYNC_FIELDS[table], SYNC_GROUPS[table]).filter(u => u.some(f => m.applied.includes(f))).flat();
  return { body: rest, stamp: won.length ? { fields: won, at } : null };
}

/** The fields a change made earlier put in, stamped with when it was made. */
function _stampMade(table, where, args, stamp) {
  if (!stamp) return;
  const cur = db.prepare(`SELECT field_times FROM ${table} WHERE ${where}`).get(...args);
  if (!cur) return;
  db.prepare(`UPDATE ${table} SET field_times = ? WHERE ${where}`).run(JSON.stringify(stampTimes(rowTimes(cur, null), stamp.fields, stamp.at)), ...args);
}

router.patch('/:id', wrap((req, res) => {
  const id = idParam(req);
  const { body, stamp } = req.body?.edited_at != null
    ? _madeBefore(req, 'notes', db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(id), req.body)
    : { body: req.body || {}, stamp: null };
  let note = Notes.updateNote(uid(req), id, body);
  if (note && stamp) { _stampMade('notes', 'id = ?', [id], stamp); note = Notes.getNote(uid(req), id) || note; }
  return note ? res.json(note) : notFound(res);
}));

router.post('/:id/convert', wrap((req, res) => {
  const kind = req.body?.kind;
  if (!Notes.NOTE_KINDS.has(kind)) return res.status(400).json({ error: 'kind must be text or checklist' });
  const note = Notes.convertNote(uid(req), idParam(req), kind);
  return note ? res.json(note) : notFound(res);
}));

// Move to trash (recoverable for 30 days).
router.delete('/:id', wrap((req, res) => {
  const note = Notes.trashNote(uid(req), idParam(req));
  return note ? res.json(note) : notFound(res);
}));

router.post('/:id/restore', wrap((req, res) => {
  const note = Notes.restoreNote(uid(req), idParam(req));
  return note ? res.json(note) : notFound(res);
}));

router.delete('/:id/forever', wrap((req, res) => {
  return Notes.deleteNoteForever(uid(req), idParam(req)) ? res.json({ ok: true }) : notFound(res);
}));

// ── Checklist items ──────────────────────────────────────────────────

router.post('/:id/items', wrap((req, res) => {
  const note = Notes.addItem(uid(req), idParam(req), req.body || {});
  return note ? res.status(201).json(note) : notFound(res);
}));

router.put('/:id/items/order', wrap((req, res) => {
  const uuids = Array.isArray(req.body?.uuids) ? req.body.uuids.filter(u => typeof u === 'string') : [];
  const note = Notes.reorderItems(uid(req), idParam(req), uuids);
  return note ? res.json(note) : notFound(res);
}));

router.patch('/:id/items/:uuid', wrap((req, res) => {
  const { body, stamp } = req.body?.edited_at != null
    ? _madeBefore(req, 'checklist_items', db.prepare('SELECT * FROM checklist_items WHERE uuid = ? AND note_id = ? AND deleted_at IS NULL').get(req.params.uuid, idParam(req)), req.body)
    : { body: req.body || {}, stamp: null };
  const note = Notes.updateItem(uid(req), idParam(req), req.params.uuid, body);
  if (note && stamp) _stampMade('checklist_items', 'uuid = ? AND note_id = ?', [req.params.uuid, idParam(req)], stamp);
  return note ? res.json(note) : res.status(404).json({ error: 'Item not found' });
}));

router.delete('/:id/items/:uuid', wrap((req, res) => {
  const note = Notes.deleteItem(uid(req), idParam(req), req.params.uuid);
  return note ? res.json(note) : notFound(res);
}));

router.get('/:id/backlinks', wrap((req, res) => {
  const list = Notes.listBacklinks(uid(req), idParam(req));
  return list ? res.json(list) : notFound(res);
}));

// ── Attachments ──────────────────────────────────────────────────────
// Images are uploaded first through /api/upload; these link the stored
// file to the note. Body: { attachments: [{ uuid?, url, mime?, width?, height? }] }

router.post('/:id/attachments', wrap((req, res) => {
  const list = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const note = Notes.addAttachments(uid(req), idParam(req), list);
  return note ? res.status(201).json(note) : notFound(res);
}));

router.get('/:id/attachments/:uuid/drawing', wrap((req, res) => {
  const drawing = Notes.getAttachmentDrawing(uid(req), idParam(req), req.params.uuid);
  return drawing ? res.json(drawing) : res.status(404).json({ error: 'Drawing not found' });
}));

router.patch('/:id/attachments/:uuid', wrap((req, res) => {
  const note = Notes.updateAttachment(uid(req), idParam(req), req.params.uuid, req.body || {});
  return note ? res.json(note) : res.status(404).json({ error: 'Attachment not found' });
}));

router.delete('/:id/attachments/:uuid', wrap((req, res) => {
  const note = Notes.deleteAttachment(uid(req), idParam(req), req.params.uuid);
  return note ? res.json(note) : notFound(res);
}));

// ── Sharing ──────────────────────────────────────────────────────────
// Needs user accounts (multi-user mode). The owner adds, changes, and
// removes members; a member can remove themselves (leave).

const sendResult = (res, r) => r.error ? res.status(r.status || 400).json({ error: r.error }) : res.json(r);

router.get('/:id/members', wrap((req, res) => {
  const r = Notes.listMembers(uid(req), idParam(req));
  return r ? res.json(r) : notFound(res);
}));

router.post('/:id/members', wrap((req, res) => {
  sendResult(res, Notes.addMember(uid(req), idParam(req), req.body || {}));
}));

router.patch('/:id/members/:userId', wrap((req, res) => {
  sendResult(res, Notes.updateMember(uid(req), idParam(req), parseInt(req.params.userId, 10), req.body || {}));
}));

router.delete('/:id/members/:userId', wrap((req, res) => {
  sendResult(res, Notes.removeMember(uid(req), idParam(req), parseInt(req.params.userId, 10)));
}));

// Public link: owner only. GET reads it, POST creates it, DELETE removes it.
router.get('/:id/public-link', wrap((req, res) => {
  const r = Notes.getPublicLink(uid(req), idParam(req));
  return r ? res.json(r) : notFound(res);
}));

router.post('/:id/public-link', wrap((req, res) => {
  sendResult(res, Notes.createPublicLink(uid(req), idParam(req)));
}));

router.delete('/:id/public-link', wrap((req, res) => {
  sendResult(res, Notes.revokePublicLink(uid(req), idParam(req)));
}));

// ── Versions ─────────────────────────────────────────────────────────

router.get('/:id/versions', wrap((req, res) => {
  const versions = Notes.listVersions(uid(req), idParam(req));
  return versions ? res.json(versions) : notFound(res);
}));

router.post('/:id/versions/:versionId/restore', wrap((req, res) => {
  const note = Notes.restoreVersion(uid(req), idParam(req), parseInt(req.params.versionId, 10));
  return note ? res.json(note) : res.status(404).json({ error: 'Version not found' });
}));

export default router;
