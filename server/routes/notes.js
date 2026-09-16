/**
 * notes.js: REST routes for notes, checklist items, and versions.
 * Thin layer over server/lib/notes.js, which owns the rules.
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import * as Notes from '../lib/notes.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const idParam = req => {
  const n = parseInt(req.params.id, 10);
  return Number.isFinite(n) ? n : null;
};
const notFound = res => res.status(404).json({ error: 'Note not found' });

// GET /api/notes?view=notes|archive|trash|reminders|shared&label=<id>&q=<text>
router.get('/', wrap((req, res) => {
  const view = ['notes', 'archive', 'trash', 'reminders', 'shared'].includes(req.query.view) ? req.query.view : 'notes';
  const label = parseInt(req.query.label, 10);
  res.json(Notes.listNotes(uid(req), {
    view,
    labelId: Number.isFinite(label) ? label : null,
    q: typeof req.query.q === 'string' ? req.query.q : '',
  }));
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

router.patch('/:id', wrap((req, res) => {
  const note = Notes.updateNote(uid(req), idParam(req), req.body || {});
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
  const note = Notes.updateItem(uid(req), idParam(req), req.params.uuid, req.body || {});
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
