// Imported into the generated service worker (vite.config.js workbox.importScripts).
// Clicking a reminder notification focuses an open NoteTrace tab and opens
// the note there, or opens a new tab on the note when none is open.
self.addEventListener('notificationclick', (event) => {
  const noteId = event.notification?.data?.noteId;
  event.notification.close();
  if (!noteId) return;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const scope = self.registration.scope;
    const tab = tabs.find(c => c.url.startsWith(scope));
    if (tab) {
      await tab.focus();
      tab.postMessage({ type: 'open-note', noteId });
      return;
    }
    await self.clients.openWindow(`${scope}#/?note=${encodeURIComponent(noteId)}`);
  })());
});
