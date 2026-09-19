/**
 * reminder-delivery.js: sends note reminders from the server.
 *
 * Checked every minute. A reminder is due when its latest occurrence
 * (repeats included, wall-clock time kept in the note's time zone) has
 * passed within the last LATE_WINDOW_MS. Each occurrence fires once:
 * notification_log is keyed by the occurrence time, so restarts, several
 * ticks inside the window, and later occurrences of a repeat never
 * double-send or get skipped.
 *
 * Delivery goes to the owner's push service (ntfy, Gotify, Apprise)
 * when "Note Reminders" is on, and to any webhook subscribed to
 * reminder.fired. The Android app schedules its own on-device
 * notifications, so this covers the web app and every other channel.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { dueOccurrence, toUtcString, LATE_WINDOW_MS } from './reminders.js';
import { pushNotify } from './push-notify.js';
import { dispatchWebhookEvent } from './webhooks.js';

export { LATE_WINDOW_MS };
const KIND = 'note_reminder';

function _setting(userId, key) {
  const r = db.prepare(`SELECT value FROM user_settings WHERE user_id IS ? AND key = ?`).get(userId ?? null, key);
  if (!r) return null;
  try { return JSON.parse(r.value); } catch { return r.value; }
}

/** Plain-text preview for the push body. */
export function reminderMessage(note, items) {
  if (note.kind === 'checklist') {
    return items.filter(i => !i.checked).slice(0, 6).map(i => `- ${i.text}`).join('\n');
  }
  return String(note.body_md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|`|\*|_)/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, 300);
}

/** Claim an occurrence. False when it was already delivered. */
function _claim(userId, noteId, occKey) {
  const seen = db.prepare(
    `SELECT 1 FROM notification_log WHERE user_id IS ? AND kind = ? AND ref_id = ? AND fired_date = ?`
  ).get(userId ?? null, KIND, noteId, occKey);
  if (seen) return false;
  try {
    db.prepare(`INSERT INTO notification_log (user_id, kind, ref_id, fired_date) VALUES (?, ?, ?, ?)`)
      .run(userId ?? null, KIND, noteId, occKey);
    return true;
  } catch {
    return false; // another tick claimed it first
  }
}

export async function deliverDueReminders(now = new Date()) {
  const notes = db.prepare(
    `SELECT id, user_id, title, body_md, kind, reminder_at, reminder_rrule, reminder_tz
       FROM notes WHERE reminder_at IS NOT NULL AND deleted_at IS NULL AND trashed_at IS NULL`
  ).all();
  let sent = 0;
  for (const note of notes) {
    const occ = dueOccurrence(note, now);
    if (!occ) continue;
    const occKey = toUtcString(occ);
    if (!_claim(note.user_id, note.id, occKey)) continue;
    sent++;

    const items = note.kind === 'checklist'
      ? db.prepare(`SELECT text, checked FROM checklist_items WHERE note_id = ? AND deleted_at IS NULL ORDER BY position, id`).all(note.id)
      : [];
    const message = reminderMessage(note, items);
    const title = note.title || message.split('\n')[0].slice(0, 80) || 'Reminder';
    const body = note.title ? message : message.split('\n').slice(1).join('\n');

    if (_setting(note.user_id, 'notifNoteReminders') !== false) {
      try { await pushNotify(note.user_id, null, title, body || title); }
      catch (e) { logger.debug?.(`[reminders] push failed for note ${note.id}: ${e.message}`); }
    }
    if (note.user_id != null) {
      try {
        dispatchWebhookEvent(note.user_id, 'reminder.fired', {
          note_id: note.id,
          title: note.title,
          reminder_at: occ.toISOString(),
          repeat: note.reminder_rrule || null,
        });
      } catch { /* never let a webhook failure stop delivery */ }
    }
  }
  return sent;
}

/** Drop dedupe rows older than a repeat can reach back (keeps the table small). */
export function pruneReminderLog() {
  const cutoff = new Date(Date.now() - 45 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`DELETE FROM notification_log WHERE kind = ? AND fired_at < ?`).run(KIND, cutoff);
}
