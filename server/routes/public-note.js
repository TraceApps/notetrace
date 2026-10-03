/**
 * public-note.js: read a note through its public link.
 *
 * Mounted before the setup-required gate and without requireAuth: the
 * token is the only thing that grants access, and it reads one note, never
 * writes. See getPublicNote in lib/notes.js for what a stranger can see.
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { getPublicNote } from '../lib/notes.js';

const router = Router();

router.get('/:token', wrap((req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  const note = getPublicNote(req.params.token);
  if (!note) return res.status(404).json({ error: 'This link was removed or never existed' });
  res.json(note);
}));

export default router;
