import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { push } from 'svelte-spa-router';
import { LocalNotifications } from '@capacitor/local-notifications';
import { isNative } from './platform.js';
import { requestPermission } from './notifications.js';
import { notifLocalEnabled, notifTraceResults } from '../stores/settings.js';
import { showToast, dismissToast } from '../stores/toast.js';
import { traceNoteKey } from './trace-sessions.js';
import { createTraceNotifier, shouldNotifyTrace } from './trace-notification-core.js';
import { notificationHistory } from './notification-history.js';
import { notificationSoundSilent } from './notification-sounds.js';
import { traceChatRequests, traceChatOpen } from './trace-chat.js';
import { notificationPopup } from './notification-popup.js';

const enabled = () => get(notifLocalEnabled) !== false && get(notifTraceResults) !== false;
const owner = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const reviewToasts = new Set();
let permissionAsked = false;
const notifier = createTraceNotifier({
  native: isNative,
  plugin: LocalNotifications,
  owner,
  enabled,
  isCurrent: data => data.owner === owner && (data.kind === 'trace-chat'
    ? traceChatRequests.isCurrent(data.key) : data.noteId != null && traceNoteKey(data.noteId) === data.key),
  open: (noteId, data) => {
    if (data.kind === 'trace-chat') { traceChatOpen.set(true); return; }
    push(`/?note=${encodeURIComponent(noteId)}&trace=1`);
  },
  copy: event => {
    const t = get(_);
    const chat = event.kind === 'trace-chat';
    const text = { channel: t('trace_notifications.channel'),
      title: t(event.failure ? 'trace_notifications.failed' : chat ? 'trace_notifications.chat_ready' : 'trace_notifications.ready'),
      body: chat ? t('trace_notifications.chat_review') : t('trace_notifications.review', { values: { title: event.title.trim() || t('notes.untitled') } }),
      review: t('trace_notifications.action') };
    notificationHistory.add({ id: `trace:${event.key}`, kind: chat ? 'trace-chat' : 'trace-result', noteId: event.noteId, title: text.title, body: text.body });
    if (!isNative) text.silent = notificationSoundSilent();
    return text;
  },
  fallback: (text, review) => {
    // Browser fallback is anchored beneath the history bell by the history store.
    if (!isNative) {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') notificationPopup.show({ title: text.title, body: text.body, run: review });
      return;
    }
    const id = showToast(`${text.title} — ${text.body}`, 12000, 'info', {
      label: text.review, run: () => { dismissToast(id); reviewToasts.delete(id); review(); },
    });
    reviewToasts.add(id);
    setTimeout(() => reviewToasts.delete(id), 12000);
  },
  web: {
    permission: () => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
    registration: () => navigator.serviceWorker?.getRegistration?.(),
    clientId: registration => new Promise(resolve => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); resolve(null); }, 1000);
      channel.port1.onmessage = event => { clearTimeout(timeout); channel.port1.close(); resolve(event.data); };
      registration.active?.postMessage({ type: 'trace-client-id' }, [channel.port2]);
    }),
    create: (title, options) => new Notification(title, options),
    focus: () => window.focus(),
  },
});

// Called from the user's Ask Trace click, never when a background request ends.
export function requestTracePermission() {
  if (enabled() && !permissionAsked) {
    permissionAsked = true;
    requestPermission().catch(() => {});
  }
}

export function notifyTraceCompletion(event) {
  if (!shouldNotifyTrace({ viewing: event.isViewing(), visibility: document.visibilityState, focused: document.hasFocus() })) return;
  return notifier.show(event);
}

export function notifyTraceChatCompletion(event) { return notifier.show(event); }

export function startTraceNotifications() {
  notifier.start().catch(() => {});
  if (!isNative) navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'trace-result') notifier.activate(event.data);
  });
}

export async function clearTraceNotifications() {
  for (const id of reviewToasts) dismissToast(id);
  reviewToasts.clear();
  await notifier.clear();
}
