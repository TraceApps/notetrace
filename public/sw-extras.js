// Imported into the generated service worker (vite.config.js workbox.importScripts).
//
// Reminder notifications: a click focuses an open NoteTrace tab and opens
// the note there, or opens a new tab on the note when none is open.
//
// Share target: the installed app receives shares as a POST with photos.
// The photos are held in Cache Storage under a one-time id, and the share
// is redirected into the app, which reads them back (src/lib/share-intent.js).
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
    await self.clients.openWindow(noteId === 'tasks' ? `${scope}#/tasks` : `${scope}#/?note=${encodeURIComponent(noteId)}`);
  })());
});

const SHARE_CACHE = 'note-share';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || !url.pathname.endsWith('/share-target')) return;
  event.respondWith((async () => {
    const scope = self.registration.scope;
    const params = new URLSearchParams({ share: '1' });
    try {
      const form = await event.request.formData();
      for (const k of ['title', 'text', 'url']) {
        const v = form.get(k);
        if (typeof v === 'string' && v) params.set(k, v.slice(0, 20000));
      }
      const images = form.getAll('images').filter(f => f && typeof f === 'object' && /^(image|audio)\//.test(f.type)).slice(0, 20);
      if (images.length) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const cache = await caches.open(SHARE_CACHE);
        await Promise.all(images.map((f, i) => cache.put(
          new Request(`${scope}__share/${id}/${i}`),
          new Response(f, { headers: { 'Content-Type': f.type, 'X-File-Name': encodeURIComponent(f.name || `image-${i + 1}`) } }),
        )));
        params.set('files', id);
      }
    } catch (e) {
      // Fall through with whatever text was read.
    }
    return Response.redirect(`${scope}#/?${params.toString()}`, 303);
  })());
});
