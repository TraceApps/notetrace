/**
 * note-reminders.js: note reminders on Android.
 *
 * Scheduling is native (NoteReminderScheduler.java): exact alarms, so
 * reminders fire on time with the app closed, after a reboot, and across
 * daylight saving changes. After every note change or sync this module hands
 * the native side the full reminder list with notification text worked out
 * (the native code never opens the app's database), passes the device
 * setting and translated strings, and routes notification taps and Done
 * actions back into the app.
 *
 * Web and PWA reminders live in web-reminders.js; this module is a no-op
 * there.
 */
import { registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { isNative } from './platform.js';
import { NoteApi } from './api.js';
import { REPEATS } from './reminders.js';
import { reminderNotificationText } from './note-preview.js';

const NoteReminders = isNative ? registerPlugin('NoteReminders') : null;

// Range the earlier LocalNotifications-based scheduler used; cleared once so
// those notifications don't fire alongside the native ones.
const LEGACY_MIN = 1_000_000;
const LEGACY_MAX = 3_000_000;
const LEGACY_CLEARED_KEY = 'note:legacyRemindersCleared';

let _timer = null;
let _listening = false;
let _config = { enabled: true, labels: {} };

/** Device setting and notification strings in the active language. */
export async function configureReminders({ enabled, labels } = {}) {
  if (!NoteReminders) return;
  if (enabled !== undefined) _config.enabled = enabled !== false;
  if (labels) _config.labels = { ..._config.labels, ...labels };
  try { await NoteReminders.configure(_config); } catch { /* older build without the plugin */ }
}

/** Ask for notification permission the first time a reminder is set. */
export async function ensureReminderPermission() {
  if (!isNative) return true;
  try {
    const cur = await LocalNotifications.checkPermissions();
    if (cur.display === 'granted') return true;
    const r = await LocalNotifications.requestPermissions();
    return r.display === 'granted';
  } catch { return false; }
}

async function _clearLegacy() {
  try {
    if (localStorage.getItem(LEGACY_CLEARED_KEY)) return;
    const pending = await LocalNotifications.getPending();
    const old = (pending.notifications || []).filter(n => n.id >= LEGACY_MIN && n.id < LEGACY_MAX).map(n => ({ id: n.id }));
    if (old.length) await LocalNotifications.cancel({ notifications: old });
    localStorage.setItem(LEGACY_CLEARED_KEY, '1');
  } catch { /* try again next launch */ }
}

async function _reschedule() {
  const notes = await NoteApi.getNotes({ view: 'reminders' });
  const fallback = _config.labels.reminder || 'Reminder';
  const reminders = notes
    .filter(n => n.reminder_at)
    .map(n => {
      const { title, body } = reminderNotificationText(n, fallback);
      return { id: n.id, title, body, at: n.reminder_at, rrule: n.reminder_rrule || null, tz: n.reminder_tz || null };
    });
  await NoteReminders.reschedule({ reminders });
}

/** Hand the native side the current reminder list. Debounced; safe to call after every change. */
export function rescheduleReminders() {
  if (!NoteReminders) return;
  clearTimeout(_timer);
  _timer = setTimeout(() => { _reschedule().catch(() => {}); }, 400);
}

/** Clear one-off reminders the user marked Done from a notification. */
async function _applyDone(onChanged) {
  let ids = [];
  try { ({ noteIds: ids = [] } = await NoteReminders.takeDone()); } catch { return; }
  if (!ids.length) return;
  for (const id of ids) {
    try {
      const note = await NoteApi.getNote(id);
      if (note?.reminder_at && !REPEATS.includes(note.reminder_rrule)) {
        await NoteApi.updateNote(id, { reminder_at: null });
      }
    } catch { /* note gone */ }
  }
  onChanged?.();
  rescheduleReminders();
}

/** Whether Android lets NoteTrace fire at the exact minute. */
export async function exactAlarmStatus() {
  if (!NoteReminders) return { exact: true };
  try { return await NoteReminders.exactAlarmStatus(); } catch { return { exact: true }; }
}

export async function openExactAlarmSettings() {
  try { await NoteReminders?.openExactAlarmSettings(); } catch { /* ignore */ }
}

/**
 * Route notification taps to the note, and refresh after Done cleared a
 * reminder natively. `openNote(id)` opens a note; `onChanged()` reloads.
 * Registered once from App.svelte.
 */
export async function registerReminderActions(openNote, onChanged) {
  if (!NoteReminders || _listening) return;
  _listening = true;
  await _clearLegacy();
  try {
    await NoteReminders.addListener('reminderOpen', ({ noteId }) => { if (noteId) openNote(noteId); });
    // Done while the app runs; updateNote queues the change for sync.
    await NoteReminders.addListener('remindersChanged', () => { _applyDone(onChanged); });
    // Done while the app was closed: picked up at start and on every resume.
    await _applyDone(onChanged);
    try {
      const { App } = await import('@capacitor/app');
      App.addListener('appStateChange', ({ isActive }) => { if (isActive) _applyDone(onChanged); });
    } catch { /* ignore */ }
    const { noteId } = await NoteReminders.getPendingOpen();
    if (noteId) openNote(noteId);
  } catch (e) {
    console.warn('[reminders] native bridge unavailable:', e?.message || e);
  }
}
