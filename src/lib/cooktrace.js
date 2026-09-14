/**
 * cooktrace.js: the CookTrace link on this device. The server holds the
 * token and talks to CookTrace (server/lib/cooktrace.js); this only knows
 * whether a link exists. Needs a server, so it is off in local-only mode.
 */
import { writable } from 'svelte/store';
import { NoteApi } from './api.js';
import { isNative, getServerUrl } from './platform.js';

export const cooktraceAvailable = !isNative || !!getServerUrl();

/** { connected, url, username } once loaded; null before. */
export const cooktraceLink = writable(null);

let _loading = null;
export function loadCooktraceLink({ force = false } = {}) {
  if (!cooktraceAvailable) { cooktraceLink.set({ connected: false }); return Promise.resolve({ connected: false }); }
  if (_loading && !force) return _loading;
  _loading = NoteApi.get('/api/integrations/cooktrace')
    .then((link) => { cooktraceLink.set(link); return link; })
    .catch(() => { _loading = null; const off = { connected: false }; cooktraceLink.set(off); return off; });
  return _loading;
}

export async function linkCooktrace(url, token) {
  const link = await NoteApi.put('/api/integrations/cooktrace', { url, token });
  cooktraceLink.set(link);
  _loading = Promise.resolve(link);
  return link;
}

export async function unlinkCooktrace() {
  const link = await NoteApi.del('/api/integrations/cooktrace');
  cooktraceLink.set(link);
  _loading = Promise.resolve(link);
  return link;
}

/** Unchecked checklist items to the CookTrace shopping list. Resolves { added, failed, error? }. */
export function sendToCooktrace(items) {
  return NoteApi.post('/api/integrations/cooktrace/shopping', {
    items: (items || []).map(i => ({ text: i.text, checked: !!i.checked })),
  });
}
