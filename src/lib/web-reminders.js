/**
 * web-reminders.js: reminder notifications in the browser (web and PWA).
 *
 * A web page can't schedule a notification for later, so this only works
 * while NoteTrace is open in a tab (it can be in the background). Every
 * 20 seconds it looks for reminder occurrences that just came due and
 * shows each one once. Reminders while the browser is closed come from
 * the server's push service instead.
 *
 * Each shown occurrence is recorded in localStorage, so a reload or a
 * second open tab doesn't show it again.
 */
import { get } from 'svelte/store';
import { push } from 'svelte-spa-router';
import { NoteApi } from './api.js';
import { dueOccurrence, toUtcString } from './reminders.js';
import { reminderNotificationText } from './note-preview.js';
import { notifLocalEnabled } from '../stores/settings.js';
import { notesChanged } from '../stores/notes.js';
import { DB } from './db.js';
import { buildTaskDigest, localParts, timeToMinutes } from '../../server/lib/task-digest-core.js';

const TICK_MS = 20 * 1000;
const REFRESH_MS = 5 * 60 * 1000;
// Shows an occurrence up to this late (a tab that was asleep, a slow tick).
const WINDOW_MS = 10 * 60 * 1000;
const FIRED_KEY = 'note:webRemindersFired';
const FIRED_KEEP_MS = 7 * 86400000;

let _notes = [];
let _loadedAt = 0;
let _started = false;
let _label = 'Reminder';

export function setWebReminderLabel(label) { if (label) _label = label; }

export function webNotificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function _enabled() {
  return webNotificationsSupported() && Notification.permission === 'granted' && get(notifLocalEnabled) !== false;
}

function _readFired() {
  try { return JSON.parse(localStorage.getItem(FIRED_KEY) || '{}') || {}; } catch { return {}; }
}

/** Claim an occurrence. False when this browser already showed it. */
function _claim(key, now) {
  const fired = _readFired();
  if (fired[key]) return false;
  for (const [k, t] of Object.entries(fired)) if (now - t > FIRED_KEEP_MS) delete fired[k];
  fired[key] = now;
  try { localStorage.setItem(FIRED_KEY, JSON.stringify(fired)); } catch { /* private mode: may repeat once */ }
  return true;
}

async function _load() {
  try {
    _notes = await NoteApi.getNotes({ view: 'reminders' });
    _loadedAt = Date.now();
  } catch { /* offline or signed out; try again next tick */ }
}

async function _show(note) {
  const { title, body } = reminderNotificationText(note, _label);
  const options = { body, tag: `note-reminder-${note.id}`, data: { noteId: note.id }, icon: 'icons/icon-192.png' };
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.showNotification) { await reg.showNotification(title, options); return; }
  } catch { /* fall through to a page notification */ }
  try {
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); openNoteFromNotification(note.id); n.close(); };
  } catch { /* some mobile browsers only allow service-worker notifications */ }
}

export function openNoteFromNotification(noteId) {
  if (noteId === 'tasks') { push('/tasks'); return; }
  if (noteId) push(`/?note=${encodeURIComponent(noteId)}`);
}

// Tasks Due, once a day at the Tasks Due time, while a tab is open.
let _checklists = [];
async function _tasksDigestTick(now) {
  const enabled = DB.getSetting('notifTasksDue', true);
  if (enabled === false || enabled === 'false') return;
  const { date, minutes } = localParts(now);
  const at = timeToMinutes(DB.getSetting('tasksDigestTime', '09:00'));
  if (minutes < at || minutes > Math.max(at, 20 * 60)) return;
  const fired = _readFired();
  if (fired[`tasks@${date}`]) return;
  try { _checklists = (await NoteApi.getNotes({ view: 'notes' })).filter(n => n.kind === 'checklist'); } catch { return; }
  const digest = buildTaskDigest(_checklists.flatMap(n => (n.items || []).map(i => ({ ...i, list: n.title || '' }))), date);
  if (!_claim(`tasks@${date}`, now.getTime()) || !digest) return;
  const options = { body: digest.body, tag: `tasks-due-${date}`, data: { noteId: 'tasks' }, icon: 'icons/icon-192.png' };
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.showNotification) { await reg.showNotification(digest.title, options); return; }
  } catch { /* fall through */ }
  try {
    const n = new Notification(digest.title, options);
    n.onclick = () => { window.focus(); push('/tasks'); n.close(); };
  } catch { /* service-worker only browsers */ }
}

async function _tick() {
  if (!_enabled()) return;
  if (!_loadedAt || Date.now() - _loadedAt > REFRESH_MS) await _load();
  const now = new Date();
  for (const note of _notes) {
    const occ = dueOccurrence(note, now, WINDOW_MS);
    if (!occ) continue;
    if (!_claim(`${note.id}@${toUtcString(occ)}`, now.getTime())) continue;
    await _show(note);
  }
  await _tasksDigestTick(now);
}

/** Start the reminder loop. Web only; the Android app schedules natively. */
export function startWebReminders() {
  if (_started || !webNotificationsSupported()) return;
  _started = true;
  // Reload the list whenever notes change here or through another tab's sync.
  notesChanged.subscribe(() => { _loadedAt = 0; });
  notifLocalEnabled.subscribe(() => { _loadedAt = 0; });
  // A click on a service-worker notification asks the page to open the note.
  navigator.serviceWorker?.addEventListener?.('message', (e) => {
    if (e.data?.type === 'open-note') openNoteFromNotification(e.data.noteId);
  });
  setTimeout(_tick, 3000);
  setInterval(_tick, TICK_MS);
}
