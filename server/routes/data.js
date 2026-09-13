import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

// Tables scoped by user_id that have a soft-delete column. DELETE +
// live-export both filter deleted_at IS NULL so users only see rows
// they can still see in the UI.
const TABLES = ['notes'];

// User-owned tables that also carry deleted_at (soft-delete). Same
// filter as TABLES on export; not touched by DELETE, which is scoped to
// the primary content set only.
const TABLES_SOFT_DELETE_EXTRA = ['user_settings'];

// User-owned tables with no deleted_at: hard-delete only. Include
// everything on export.
const TABLES_HARD = ['ai_chat_history'];

router.delete('/', wrap((req, res) => {
  const u = uid(req);
  for (const t of TABLES) {
    if (u == null) {
      db.prepare(`UPDATE ${t} SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE deleted_at IS NULL`).run();
    } else {
      db.prepare(`UPDATE ${t} SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL`).run(u);
    }
  }
  res.json({ ok: true });
}));

router.get('/export', wrap((req, res) => {
  const u = uid(req);
  const out = { exportedAt: new Date().toISOString() };

  for (const t of [...TABLES, ...TABLES_SOFT_DELETE_EXTRA]) {
    out[t] = u == null
      ? db.prepare(`SELECT * FROM ${t} WHERE deleted_at IS NULL`).all()
      : db.prepare(`SELECT * FROM ${t} WHERE user_id = ? AND deleted_at IS NULL`).all(u);
  }

  for (const t of TABLES_HARD) {
    out[t] = u == null
      ? db.prepare(`SELECT * FROM ${t}`).all()
      : db.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).all(u);
  }

  res.json(out);
}));

export default router;
