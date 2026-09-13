/**
 * labels.js: REST routes for note labels. Thin layer over
 * server/lib/notes.js.
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import * as Notes from '../lib/notes.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

router.get('/', wrap((req, res) => {
  res.json(Notes.listLabels(uid(req)));
}));

router.post('/', wrap((req, res) => {
  const label = Notes.createLabel(uid(req), req.body || {});
  if (label?.error) return res.status(400).json(label);
  res.status(201).json(label);
}));

router.put('/order', wrap((req, res) => {
  res.json(Notes.reorderLabels(uid(req), Array.isArray(req.body?.ids) ? req.body.ids : []));
}));

router.patch('/:id', wrap((req, res) => {
  const label = Notes.updateLabel(uid(req), parseInt(req.params.id, 10), req.body || {});
  if (!label) return res.status(404).json({ error: 'Label not found' });
  if (label.error) return res.status(400).json(label);
  res.json(label);
}));

router.delete('/:id', wrap((req, res) => {
  return Notes.deleteLabel(uid(req), parseInt(req.params.id, 10))
    ? res.json({ ok: true })
    : res.status(404).json({ error: 'Label not found' });
}));

export default router;
