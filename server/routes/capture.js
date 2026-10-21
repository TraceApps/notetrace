import { Router } from 'express';
import { bearerAuth, requireScope } from '../middleware/bearer-auth.js';
import { importCapture } from '../lib/capture.js';
import db from '../db.js';

const router = Router();
router.use((_req, res, next) => /^(1|true|yes|on)$/i.test(process.env.CAPTURE_ENABLED || '')
  ? next() : res.status(404).json({ error: 'Capture is disabled. Enable CAPTURE_ENABLED=1 on NoteTrace.' }));
router.use(bearerAuth, requireScope('capture:write'));
router.get('/capabilities', (req, res) => {
  const setting = key => {
    try { return JSON.parse(db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(req.apiUser.id, key)?.value ?? 'null'); }
    catch { return null; }
  };
  const service = setting('notifPushService');
  const serverPush = service === 'gotify' ? !!(setting('gotifyUrl') && setting('gotifyToken'))
    : service === 'ntfy' ? !!setting('ntfyTopic') : service === 'apprise' ? !!setting('appriseUrl') : false;
  res.json({ version: 1, markdown: true, tasks: true, reminders: true, max_entries: 50,
    account: req.apiUser.username, notifications: { note_reminders: setting('notifNoteReminders') !== false,
      server_push_configured: serverPush,
      message: 'Reminders use your existing NoteTrace notification channels. Browser notifications require an open tab; configure Android or server push for delivery while closed.' } });
});
router.post('/', (req, res) => {
  try { res.json(importCapture(req.apiUser.id, req.body)); }
  catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Capture failed. You can retry this save safely.' }); }
});
export default router;
