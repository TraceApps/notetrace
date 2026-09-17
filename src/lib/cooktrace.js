/**
 * cooktrace.js: the CookTrace link on this device. The server holds the
 * token and talks to CookTrace (server/lib/cooktrace.js); this only knows
 * whether a link exists. Needs a server, so it is off in local-only mode.
 */
import { writable, get } from 'svelte/store';
import { NoteApi } from './api.js';
import { isNative, getServerUrl } from './platform.js';

export const cooktraceAvailable = !isNative || !!getServerUrl();

/** { connected, enabled, url, username } once loaded; null before. */
export const cooktraceLink = writable(null);

/** Linked and switched on: Shopping and Send to CookTrace show. */
export const cooktraceOn = (link) => !!link?.connected && link.enabled !== false;

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

/** Check the saved link still works. Resolves the link, or throws why not. */
export async function testCooktrace() {
  const link = await NoteApi.post('/api/integrations/cooktrace/test', {});
  cooktraceLink.set(link);
  _loading = Promise.resolve(link);
  return link;
}

export async function setCooktraceEnabled(enabled) {
  const link = await NoteApi.patch('/api/integrations/cooktrace', { enabled: !!enabled });
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

/** Unchecked checklist items to the CookTrace shopping list. Resolves { added, skipped, names }. */
export function sendToCooktrace(items) {
  return NoteApi.post('/api/integrations/cooktrace/shopping', {
    items: (items || []).map(i => ({ text: i.text, checked: !!i.checked })),
  });
}

// ── The CookTrace shopping list ───────────────────────────────────────
// Shown live from CookTrace (through this server). The last list is kept on
// this device so it still shows without a connection, and ticks, adds, and
// clears made offline wait in a small queue and go up when the connection
// is back, in order.

/** { items, at, loading, error, offline, pending } */
export const shopping = writable({ items: null, at: null, loading: false, error: null, offline: false, pending: 0 });

function _key(name) {
  let user = null;
  try { user = localStorage.getItem('wl:userId'); } catch { /* private mode */ }
  return `note:cooktrace:${name}:${user || 'single'}`;
}
function _read(name, fallback) {
  try { return JSON.parse(localStorage.getItem(_key(name))) ?? fallback; } catch { return fallback; }
}
function _write(name, value) {
  try { localStorage.setItem(_key(name), JSON.stringify(value)); } catch { /* storage full or blocked */ }
}
const _queue = () => _read('queue', []);

function _publish(patch) {
  shopping.update(s => ({ ...s, ...patch, pending: _queue().length }));
}

const _isOffline = (e) => e?.name === 'TypeError' || /API error 50[234]|Failed to fetch|NetworkError/i.test(e?.message || '') || (typeof navigator !== 'undefined' && navigator.onLine === false);

let _flushing = null;
async function _flush() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    let queue = _queue();
    while (queue.length) {
      const op = queue[0];
      try {
        if (op.type === 'check') await NoteApi.patch(`/api/integrations/cooktrace/shopping/${op.id}`, { checked: op.checked });
        else if (op.type === 'add') await NoteApi.post('/api/integrations/cooktrace/shopping', { items: [op.name] });
        else if (op.type === 'clear') await NoteApi.del('/api/integrations/cooktrace/shopping/checked');
      } catch (e) {
        if (_isOffline(e)) { _publish({ offline: true }); return false; }
        // CookTrace said no (the item is gone, say): drop it and carry on.
      }
      queue = _queue().slice(1);
      _write('queue', queue);
    }
    _publish({});
    return true;
  })().finally(() => { _flushing = null; });
  return _flushing;
}

/** Fetch the list from CookTrace; on no connection, keep showing the saved one. */
export async function loadShopping() {
  const cached = _read('list', null);
  _publish({ loading: true, ...(cached && !get(shopping).items ? { items: cached.items, at: cached.at } : {}) });
  await _flush();
  try {
    const { items } = await NoteApi.get('/api/integrations/cooktrace/shopping');
    const at = new Date().toISOString();
    _write('list', { items, at });
    _publish({ items, at, loading: false, error: null, offline: false });
  } catch (e) {
    const offline = _isOffline(e);
    _publish({ loading: false, offline, error: offline ? null : (e.message || 'CookTrace could not be reached') });
  }
}

function _queueOp(op) {
  _write('queue', [..._queue(), op]);
  _publish({});
}

/** Check an item off (or back on). Shows at once; goes to CookTrace now or when back online. */
export async function setShoppingChecked(id, checked) {
  _queueOp({ type: 'check', id, checked: !!checked });
  if (await _flush()) _refreshSoon();
}

/** Add typed items. */
export async function addShoppingItem(name) {
  const clean = String(name || '').trim();
  if (!clean) return;
  _queueOp({ type: 'add', name: clean, tempId: `tmp-${Date.now()}` });
  if (await _flush()) await loadShopping();
}

/** Clear checked items. */
export async function clearCheckedShopping() {
  _queueOp({ type: 'clear' });
  if (await _flush()) await loadShopping();
}

let _refreshTimer = null;
function _refreshSoon() {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => { loadShopping(); }, 1200);
}

/** Pending changes, for the page to lay over the saved list. */
export const shoppingQueue = () => _queue();

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { if (_queue().length) _flush().then(ok => ok && loadShopping()); });
}
