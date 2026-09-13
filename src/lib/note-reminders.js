/**
 * note-reminders.js: schedules note reminders as Android notifications.
 *
 * The notification set is rebuilt from the note list rather than patched
 * one note at a time: after any note change or sync, every pending
 * reminder notification is cancelled and the current set rescheduled.
 * That keeps the device right no matter where the change came from
 * (this device, the web app, another phone via sync).
 *
 * Repeating reminders use the OS repeat, so they keep firing even when
 * the app isn't opened. Web and PWA reminders are delivered by the
 * server's push channels instead; this module is a no-op there.
 */
import { LocalNotifications } from '@capacitor/local-notifications';
import { isNative } from './platform.js';
import { NoteApi } from './api.js';
import { nextOccurrence, REPEATS } from './reminders.js';
import { markdownToPreview } from './note-preview.js';

const CHANNEL_ID = 'notetrace-reminders';
const ACTION_TYPE_ID = 'note-reminder';
const REMINDER_ID_BASE = 1_000_000;
const SNOOZE_ID_BASE = 2_000_000;
const SNOOZE_MS = 60 * 60 * 1000;
const EVERY = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };

let _prepared = false;
let _listening = false;
let _timer = null;
let _labels = { done: 'Done', snooze: 'Snooze 1 Hour', reminder: 'Reminder', channel: 'Note reminders' };

/** UI strings for the notification actions, set once i18n is ready. */
export function setReminderLabels(labels) {
  _labels = { ..._labels, ...labels };
  _prepared = false;
}

async function _prepare() {
  if (_prepared) return;
  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: _labels.channel,
      importance: 4, // HIGH: sound + heads-up, like an alarm-style reminder
      visibility: 1,
    });
    await LocalNotifications.registerActionTypes({
      types: [{
        id: ACTION_TYPE_ID,
        actions: [
          { id: 'done', title: _labels.done },
          { id: 'snooze', title: _labels.snooze },
        ],
      }],
    });
    _prepared = true;
  } catch (e) {
    console.warn('[reminders] notification setup failed:', e?.message || e);
  }
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

function _content(note) {
  const title = note.title || _labels.reminder;
  let body = note.kind === 'checklist'
    ? (note.items || []).filter(i => !i.checked).slice(0, 4).map(i => `• ${i.text}`).join('\n')
    : markdownToPreview(note.body_md, 200);
  if (!note.title && body) {
    return { title: body.split('\n')[0].slice(0, 80), body: body.split('\n').slice(1).join('\n') };
  }
  return { title, body };
}

async function _rebuild() {
  const perm = await LocalNotifications.checkPermissions().catch(() => null);
  if (perm?.display !== 'granted') return;
  await _prepare();

  const pending = await LocalNotifications.getPending().catch(() => ({ notifications: [] }));
  const stale = (pending.notifications || [])
    .filter(n => n.id >= REMINDER_ID_BASE && n.id < SNOOZE_ID_BASE)
    .map(n => ({ id: n.id }));
  if (stale.length) await LocalNotifications.cancel({ notifications: stale }).catch(() => {});

  const notes = await NoteApi.getNotes({ view: 'reminders' }).catch(() => []);
  const now = new Date();
  const notifications = [];
  for (const note of notes) {
    const repeating = REPEATS.includes(note.reminder_rrule);
    const next = nextOccurrence(note.reminder_at, note.reminder_rrule, note.reminder_tz, now);
    if (!next || (!repeating && next <= now)) continue;
    const { title, body } = _content(note);
    notifications.push({
      id: REMINDER_ID_BASE + note.id,
      channelId: CHANNEL_ID,
      actionTypeId: ACTION_TYPE_ID,
      title,
      body,
      extra: { noteId: note.id, repeating },
      schedule: repeating
        ? { at: next, repeats: true, every: EVERY[note.reminder_rrule], allowWhileIdle: true }
        : { at: next, allowWhileIdle: true },
    });
  }
  if (notifications.length) {
    await LocalNotifications.schedule({ notifications }).catch(e => {
      console.warn('[reminders] schedule failed:', e?.message || e);
    });
  }
}

/** Rebuild the scheduled reminder set. Debounced; safe to call often. */
export function rescheduleReminders() {
  if (!isNative) return;
  clearTimeout(_timer);
  _timer = setTimeout(() => { _rebuild().catch(() => {}); }, 400);
}

/**
 * Handle taps and the Done / Snooze buttons. `openNote(id)` routes to the
 * note. Registered once from App.svelte.
 */
export async function registerReminderActions(openNote) {
  if (!isNative || _listening) return;
  _listening = true;
  await LocalNotifications.addListener('localNotificationActionPerformed', async ({ actionId, notification }) => {
    const noteId = notification?.extra?.noteId;
    if (!noteId) return;
    if (actionId === 'done') {
      // Done clears a one-off reminder. A repeating reminder keeps going.
      if (!notification.extra.repeating) {
        try { await NoteApi.updateNote(noteId, { reminder_at: null }); } catch { /* note may be gone */ }
      }
      rescheduleReminders();
    } else if (actionId === 'snooze') {
      await _prepare();
      await LocalNotifications.schedule({
        notifications: [{
          id: SNOOZE_ID_BASE + noteId,
          channelId: CHANNEL_ID,
          actionTypeId: ACTION_TYPE_ID,
          title: notification.title,
          body: notification.body,
          extra: { noteId, repeating: !!notification.extra.repeating },
          schedule: { at: new Date(Date.now() + SNOOZE_MS), allowWhileIdle: true },
        }],
      }).catch(() => {});
    } else {
      openNote(noteId);
    }
  });
}
