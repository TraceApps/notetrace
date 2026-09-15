/**
 * scheduler.js — Server-side scheduled tasks for NoteTrace.
 *
 * A 15-minute tick runs housekeeping (expired invite tokens, trash older
 * than 30 days, old reminder dedupe rows, unused uploads once a day) and the
 * scheduled full backup.
 * A separate 1-minute tick delivers note reminders on time
 * (reminder-delivery.js, deduped through notification_log).
 *
 * Skipped silently when no users exist (single-user fresh install).
 * Cron-style is fine because we only need to-the-day accuracy; the
 * dedup log keeps us safe across server restarts.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { purgeExpiredTrash } from './notes.js';
import { deliverDueReminders, pruneReminderLog } from './reminder-delivery.js';
import { purgeOrphanUploads } from './upload-cleanup.js';

const TICK_MS = 15 * 60 * 1000; // 15 minutes
const REMINDER_TICK_MS = 60 * 1000;
let _interval = null;
let _reminderInterval = null;
let _delivering = false;
let _lastUploadCleanup = 0;

async function _reminderTick() {
  if (_delivering) return; // a slow push service must not stack ticks
  _delivering = true;
  try {
    const n = await deliverDueReminders();
    if (n > 0) logger.info?.(`[scheduler] delivered ${n} reminder(s)`);
  } catch (e) {
    logger.warn(`[scheduler] reminder tick error: ${e.message}`);
  } finally {
    _delivering = false;
  }
}

export function startScheduler() {
  // Run once at boot so a freshly-restarted server doesn't wait 15 min
  // to deliver today's reminders.
  setTimeout(() => runTick().catch(e => logger.warn(`[scheduler] tick error: ${e.message}`)), 5_000);
  setTimeout(_reminderTick, 8_000);
  _reminderInterval = setInterval(_reminderTick, REMINDER_TICK_MS);
  _interval = setInterval(() => {
    runTick().catch(e => logger.warn(`[scheduler] tick error: ${e.message}`));
  }, TICK_MS);
  logger.info(`[scheduler] running every ${TICK_MS / 60000} min`);
}

export function stopScheduler() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
  if (_reminderInterval) {
    clearInterval(_reminderInterval);
    _reminderInterval = null;
  }
}

async function runTick() {
  // Housekeeping — remove invite tokens that are past their expiry or
  // already used. GET /api/auth/invites already filters them out of the
  // admin list, but rows sit in the table indefinitely otherwise. Runs
  // every tick regardless of user count so the table stays clean even
  // when the setup is still single-user.
  try {
    const r = db.prepare(
      `DELETE FROM invite_tokens WHERE expires_at <= datetime('now') OR used = 1`
    ).run();
    if (r.changes > 0) logger.debug?.(`[scheduler] purged ${r.changes} expired/used invite tokens`);
  } catch (e) {
    logger.debug?.(`[scheduler] invite cleanup error: ${e.message}`);
  }

  // Trash retention: notes trashed more than 30 days ago are deleted
  // for good (tombstoned so the deletion syncs to every device).
  try {
    const n = purgeExpiredTrash();
    if (n > 0) logger.info?.(`[scheduler] permanently deleted ${n} note(s) from trash`);
  } catch (e) {
    logger.debug?.(`[scheduler] trash purge error: ${e.message}`);
  }

  // Uploaded files nothing refers to anymore, once a day.
  if (Date.now() - _lastUploadCleanup > 24 * 60 * 60 * 1000) {
    _lastUploadCleanup = Date.now();
    try {
      const n = purgeOrphanUploads();
      if (n > 0) logger.info?.(`[scheduler] removed ${n} unused upload(s)`);
      // Link previews nobody has looked at in a month.
      db.prepare(`DELETE FROM link_previews WHERE fetched_at < datetime('now', '-30 days')`).run();
    } catch (e) {
      logger.debug?.(`[scheduler] upload cleanup error: ${e.message}`);
    }
  }

  try { pruneReminderLog(); }
  catch (e) { logger.debug?.(`[scheduler] reminder log prune error: ${e.message}`); }

  // Scheduled full backup (admin-global). Off by default; mirrors NT's
  // scheduled-backup feature for TraceApps parity. See
  // routes/full-backup.js for the schedule config + once-per-interval
  // gating.
  try { await _checkBackupSchedule(); }
  catch (e) { logger.debug?.(`[scheduler] backup check error: ${e.message}`); }
}

const _BACKUP_INTERVAL_MS = {
  daily:   22 * 60 * 60 * 1000,
  weekly:  6.5 * 24 * 60 * 60 * 1000,
  monthly: 28 * 24 * 60 * 60 * 1000,
};

async function _checkBackupSchedule() {
  const { getScheduleConfig, runScheduledBackup } = await import('../routes/full-backup.js');
  const cfg = getScheduleConfig();
  if (cfg.schedule === 'off') return;
  const intervalMs = _BACKUP_INTERVAL_MS[cfg.schedule];
  if (!intervalMs) return;
  const [hh, mm] = cfg.time.split(':').map(n => parseInt(n, 10));
  const now = new Date();
  const scheduledMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0).getTime();
  if (now.getTime() < scheduledMs) return;
  if (cfg.lastAutoRun) {
    const lastMs = new Date(cfg.lastAutoRun).getTime();
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < intervalMs) return;
  }
  logger.info?.(`[backup] auto-backup due (schedule=${cfg.schedule}, time=${cfg.time}, retention=${cfg.retention}, last=${cfg.lastAutoRun || 'never'})`);
  try { await runScheduledBackup(); } catch {}
}
