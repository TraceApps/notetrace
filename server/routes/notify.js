/**
 * notify.js — `/api/notify/*` endpoints used by the client to trigger
 * push notifications on the user's configured service (Apprise / Gotify
 * / ntfy). The client reads the per-user config from server-synced
 * settings; the actual delivery happens server-side so secrets never
 * leave the server.
 */
import { Router } from 'express';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { pushTest, pushNotify } from '../lib/push-notify.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

// POST /api/notify/test — fire a test message via the configured push
// service. Server uses the user's stored notifPushService + secrets.
router.post('/test', async (req, res) => {
  const u = uid(req);
  try {
    await pushTest(
      u,
      req.body?.title || 'Test notification',
      req.body?.message || 'NoteTrace is connected to your push service.',
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Push failed' });
  }
});

// POST /api/notify — generic dispatch (gated by setting key).
router.post('/', async (req, res) => {
  const u = uid(req);
  const { settingKey, title, message, priority } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: 'title and message required' });
  try {
    await pushNotify(u, settingKey || null, title, message, priority || 5);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Push failed' });
  }
});

export default router;
