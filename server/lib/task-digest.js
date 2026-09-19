/**
 * task-digest.js: once a day, a push notification listing checklist items
 * due today and overdue ("3 tasks due today, 1 overdue").
 *
 * Checked every minute with the reminders. Sent at the user's Tasks Due
 * time (default 09:00) in their own time zone (the `timezone` setting each
 * device fills in), and until 20:00 that day if the server was down at the
 * set time. notification_log records the day, so it's sent once. Goes to
 * the user's push service only; the Android app and an open browser tab
 * show their own.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { pushNotify } from './push-notify.js';
import { localTimeZone } from './reminders.js';
import { buildTaskDigest, localParts, timeToMinutes, DEFAULT_DIGEST_TIME } from './task-digest-core.js';

const KIND = 'tasks_due';
const LATEST_MINUTES = 20 * 60;

function _setting(userId, key) {
  const r = db.prepare(`SELECT value FROM user_settings WHERE user_id IS ? AND key = ? AND deleted_at IS NULL`).get(userId ?? null, key);
  if (!r) return null;
  try { return JSON.parse(r.value); } catch { return r.value; }
}

/** Open, dated checklist items a user can see: their own notes and notes shared with them. */
function _tasksFor(userId) {
  return db.prepare(
    `SELECT ci.text, ci.due_date, ci.checked, n.title AS list
       FROM checklist_items ci
       JOIN notes n ON n.id = ci.note_id AND n.deleted_at IS NULL AND n.trashed_at IS NULL AND n.kind = 'checklist'
      WHERE ci.deleted_at IS NULL AND ci.checked = 0 AND ci.due_date IS NOT NULL
        AND (n.user_id IS ? OR EXISTS (SELECT 1 FROM note_members m WHERE m.note_id = n.id AND m.user_id IS ? AND m.deleted_at IS NULL))`
  ).all(userId ?? null, userId ?? null);
}

export async function deliverTaskDigests(now = new Date()) {
  const users = db.prepare(
    `SELECT DISTINCT n.user_id AS id FROM checklist_items ci JOIN notes n ON n.id = ci.note_id
      WHERE ci.deleted_at IS NULL AND ci.checked = 0 AND ci.due_date IS NOT NULL AND n.deleted_at IS NULL AND n.trashed_at IS NULL
     UNION
     SELECT DISTINCT m.user_id AS id FROM note_members m JOIN checklist_items ci ON ci.note_id = m.note_id
      WHERE m.deleted_at IS NULL AND ci.deleted_at IS NULL AND ci.checked = 0 AND ci.due_date IS NOT NULL`
  ).all();
  let sent = 0;
  for (const { id: userId } of users) {
    if (_setting(userId, 'notifTasksDue') === false) continue;
    const tz = _setting(userId, 'timezone') || localTimeZone();
    const { date, minutes } = localParts(now, tz);
    const at = timeToMinutes(_setting(userId, 'tasksDigestTime') || DEFAULT_DIGEST_TIME);
    if (minutes < at || minutes > Math.max(at, LATEST_MINUTES)) continue;
    const seen = db.prepare(`SELECT 1 FROM notification_log WHERE user_id IS ? AND kind = ? AND fired_date = ?`).get(userId ?? null, KIND, date);
    if (seen) continue;
    const digest = buildTaskDigest(_tasksFor(userId), date);
    try {
      db.prepare(`INSERT INTO notification_log (user_id, kind, ref_id, fired_date) VALUES (?, ?, 0, ?)`).run(userId ?? null, KIND, date);
    } catch { continue; }
    if (!digest) continue;
    try {
      await pushNotify(userId, null, digest.title, digest.body);
      sent++;
    } catch (e) {
      logger.debug?.(`[tasks] digest push failed for user ${userId}: ${e.message}`);
    }
  }
  return sent;
}
