// Delivery is separate from request state: permission or OS failures must never
// turn a completed generation into an AI error. Adapters are injected for tests.
export function shouldNotifyTrace({ viewing, visibility, focused }) {
  return !viewing || visibility !== 'visible' || !focused;
}

export function createTraceNotifier({ native, plugin, web, enabled, copy, open, fallback, isCurrent, owner }) {
  let listener;
  let channel;
  let epoch = 0;
  let nextId = 1_500_000_000;
  const ids = new Map();
  const pageNotifications = new Set();
  const current = data => ['trace-result', 'trace-chat'].includes(data?.kind) && isCurrent(data);
  function activate(data) { if (current(data)) open(data.noteId, data); }
  async function start() {
    if (!native) return;
    listener ??= plugin.addListener('localNotificationActionPerformed', event => activate(event.notification?.extra))
      .catch(() => { listener = null; });
    await listener;
  }
  async function show(event) {
    const data = { kind: event.kind || 'trace-result', noteId: event.noteId, key: event.key, owner };
    const generation = epoch;
    const valid = () => generation === epoch && enabled() && current(data) && event.isCurrent();
    if (!valid()) return false;
    const text = copy(event);
    try {
      if (native) {
        await start();
        const permission = await plugin.checkPermissions();
        if (permission.display === 'granted') {
          channel ??= plugin.createChannel({ id: 'notetrace-trace', name: text.channel, importance: 3, visibility: 0 })
            .catch(error => { channel = null; throw error; });
          await channel;
          if (!valid()) return false;
          if (!ids.has(event.key)) ids.set(event.key, nextId++);
          const id = ids.get(event.key);
          await plugin.schedule({ notifications: [{ id, channelId: 'notetrace-trace', title: text.title, body: text.body, extra: data }] });
          if (!valid()) { await plugin.removeDeliveredNotifications({ notifications: [{ id }] }); return false; }
          return true;
        }
      } else if (web.permission() === 'granted') {
        const registration = await web.registration();
        if (!valid()) return false;
        const options = { body: text.body, tag: `notetrace-trace:${owner}:${event.key}`, data, icon: 'icons/icon-192.png' };
        if (typeof text.silent === 'boolean') options.silent = text.silent;
        if (registration?.showNotification) {
          try {
            data.clientId = await web.clientId?.(registration);
            if (!valid()) return false;
            await registration.showNotification(text.title, options);
            if (!valid()) {
              for (const notification of await registration.getNotifications({ tag: options.tag })) notification.close();
              return false;
            }
            return true;
          } catch { /* use a page notification if service-worker delivery fails */ }
        }
        if (!valid()) return false;
        const notification = web.create(text.title, options);
        pageNotifications.add(notification);
        notification.onclick = () => { web.focus(); activate(data); notification.close(); pageNotifications.delete(notification); };
        notification.onclose = () => pageNotifications.delete(notification);
        return true;
      }
    } catch { /* an in-app Review action is available without OS permission */ }
    if (valid()) fallback(text, () => activate(data));
    return false;
  }
  async function clear() {
    epoch++;
    const notifications = [...ids.values()].map(id => ({ id }));
    ids.clear();
    for (const notification of pageNotifications) notification.close();
    pageNotifications.clear();
    try {
      if (native && notifications.length) await plugin.removeDeliveredNotifications({ notifications });
      if (!native) {
        const registration = await web.registration();
        for (const notification of await registration?.getNotifications?.() || []) {
          if (notification.tag?.startsWith('notetrace-trace:') && notification.data?.owner === owner) notification.close();
        }
      }
    } catch { /* notifications may already be gone */ }
  }
  return { show, start, clear, activate };
}
