/**
 * push-notify.js — server-side push delivery via Apprise / Gotify / ntfy.
 *
 * Reads the user's push-service config from user_settings. Helpers for
 * note reminders wrap pushNotify() with a setting key + dedup so the same
 * alert doesn't fire twice on the same day.
 *
 * Mirrors the NutriTrace push-notify shape so future TraceApps can
 * share infrastructure.
 */

import db from '../db.js';
import { logger } from '../logger.js';

// Cleanup stale dedup keys older than 7 days (runs once at module load).
try {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT key FROM app_config WHERE key LIKE '_celeb_%' OR key LIKE '_pushed_%'`).all();
  const stale = rows.filter(r => {
    const m = r.key.match(/_(\d{4}-\d{2}-\d{2})$/);
    return m && m[1] < sevenDaysAgo;
  });
  if (stale.length > 0) {
    const del = db.prepare('DELETE FROM app_config WHERE key = ?');
    for (const r of stale) del.run(r.key);
    logger.debug?.(`[push] cleaned up ${stale.length} stale dedup keys`);
  }
} catch (e) {
  logger.debug?.(`[push] dedup cleanup failed: ${e.message}`);
}

function _getUserSetting(userId, key) {
  // IS so single-user mode (user_id NULL) finds its settings too.
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id IS ? AND key = ?').get(userId ?? null, key);
  if (!row?.value) return '';
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function _isEnabled(userId, key) {
  const val = _getUserSetting(userId, key);
  return val === true || val === 'true';
}

// fetch() requires HTTP header values to be Latin-1 (ByteString) — our
// titles carry emoji/em dashes, so RFC 2047-encode when non-Latin-1 chars
// are present. ntfy decodes this natively: https://docs.ntfy.sh/publish/#e-mail-style-headers
function _encodeHeaderValue(str) {
  if (!/[^\x00-\xFF]/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

// ── Push dispatch — routes to the user's configured service ─────────────
async function _pushToService(userId, title, message, priority = 5) {
  const service = _getUserSetting(userId, 'notifPushService');
  if (!service || service === 'none') return;

  try {
    switch (service) {
      case 'gotify':  return await _pushGotify(userId, title, message, priority);
      case 'ntfy':    return await _pushNtfy(userId, title, message, priority);
      case 'apprise': return await _pushApprise(userId, title, message, priority);
    }
  } catch (e) {
    logger.warn?.(`[push] ${service} failed for user ${userId}: ${e.message}`);
  }
}

async function _pushGotify(userId, title, message, priority) {
  const url = _getUserSetting(userId, 'gotifyUrl');
  const token = _getUserSetting(userId, 'gotifyToken');
  if (!url || !token) return;
  const res = await fetch(`${url.replace(/\/+$/, '')}/message?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `NoteTrace — ${title}`, message, priority }),
  });
  if (!res.ok) throw new Error(`Gotify ${res.status}`);
  logger.debug?.(`[push] gotify: "${title}" → user ${userId}`);
}

async function _pushNtfy(userId, title, message, priority) {
  const url = _getUserSetting(userId, 'ntfyUrl') || 'https://ntfy.sh';
  const topic = _getUserSetting(userId, 'ntfyTopic');
  const token = _getUserSetting(userId, 'ntfyToken');
  if (!topic) return;
  const headers = { 'Title': _encodeHeaderValue(`NoteTrace — ${title}`), 'Priority': String(Math.min(5, priority)) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${url.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
    method: 'POST', headers, body: message,
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
  logger.debug?.(`[push] ntfy: "${title}" → user ${userId}`);
}

async function _pushApprise(userId, title, message, priority) {
  const url = _getUserSetting(userId, 'appriseUrl');
  const tag = _getUserSetting(userId, 'appriseTag');
  if (!url) return;
  const body = { title: `NoteTrace — ${title}`, body: message, type: priority >= 7 ? 'warning' : 'info' };
  if (tag) body.tag = tag;
  const res = await fetch(`${url.replace(/\/+$/, '')}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Apprise ${res.status}`);
  logger.debug?.(`[push] apprise: "${title}" → user ${userId}`);
}

// ── Public API ───────────────────────────────────────────────────────────
export async function pushNotify(userId, settingKey, title, message, priority = 5) {
  if (settingKey && !_isEnabled(userId, settingKey)) return;
  return _pushToService(userId, title, message, priority);
}

// Direct dispatch — bypasses settingKey gating. Used by the test
// button in Settings → Notifications. Skips the dedup check.
export async function pushTest(userId, title, message) {
  return _pushToService(userId, title, message, 5);
}

function _firedToday(userId, key) {
  const today = new Date().toISOString().slice(0, 10);
  const dbKey = `_pushed_${userId}_${key}_${today}`;
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(dbKey);
  if (row?.value) return true;
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(dbKey, '1');
  return false;
}
