/**
 * scheduler.js — Server-side scheduled tasks for NoteTrace.
 *
 * Single setInterval that ticks every 15 min. Each tick runs
 * housekeeping (expired invite tokens, trash older than 30 days) and the
 * scheduled full backup.
 * Note reminders (reminder_at / reminder_rrule, deduped through
 * notification_log) plug in here with the notes data layer.
 *
 * Skipped silently when no users exist (single-user fresh install).
 * Cron-style is fine because we only need to-the-day accuracy; the
 * dedup log keeps us safe across server restarts.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { purgeExpiredTrash } from './notes.js';

const TICK_MS = 15 * 60 * 1000; // 15 minutes
let _interval = null;

export function startScheduler() {
  // Run once at boot so a freshly-restarted server doesn't wait 15 min
  // to deliver today's reminders.
  setTimeout(() => runTick().catch(e => logger.warn(`[scheduler] tick error: ${e.message}`)), 5_000);
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

function _todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function _userSetting(userId, key) {
  const r = db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = ?`).get(userId, key);
  if (!r) return null;
  try { return JSON.parse(r.value); } catch { return r.value; }
}

function _alreadyFired(userId, kind, refId, today) {
  const r = db.prepare(
    `SELECT 1 FROM notification_log
      WHERE user_id = ? AND kind = ? AND ref_id IS ? AND fired_date = ? LIMIT 1`
  ).get(userId, kind, refId == null ? null : refId, today);
  return !!r;
}

function _markFired(userId, kind, refId, today) {
  try {
    db.prepare(
      `INSERT INTO notification_log (user_id, kind, ref_id, fired_date)
       VALUES (?, ?, ?, ?)`
    ).run(userId, kind, refId == null ? null : refId, today);
  } catch (e) {
    // UNIQUE conflict means another process beat us to it. Safe.
  }
}
