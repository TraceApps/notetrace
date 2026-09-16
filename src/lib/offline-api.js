/**
 * offline-api.js: the web app's notes API, able to edit without a connection.
 *
 * Online and with nothing waiting, every call goes straight to the server,
 * and the notes that come back are kept in IndexedDB (the mirror). When the
 * server can't be reached, reads come from the mirror, and note edits (text,
 * title, colour, pin, archive, labels, reminders, checklist items, trash) go
 * into an outbox and show at once. Back online, the outbox goes up as one
 * sync push, so the server merges it the way it merges the phone's changes
 * (offline-edits.js), and screens reload.
 *
 * Anything that needs the server itself (pictures, files, sharing, version
 * history, imports) says it needs a connection.
 *
 * Tabs share the outbox: a Web Lock keeps two tabs from sending it at once,
 * and a BroadcastChannel tells the others when it changed.
 */
import { writable, get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import {
  applyOps, overlayList, listView, buildPush, createdIds, isOfflineError, isTempId,
  tasksDueCount, touchedIds, NOTE_FIELDS,
} from './offline-edits.js';

// Retries while the server can't be reached: 3 s, doubling up to 30 s.
const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 30_000;
let _retryMs = RETRY_MIN_MS;
function _backoff() { const ms = _retryMs; _retryMs = Math.min(RETRY_MAX_MS, _retryMs * 2); return ms; }
// Server-only work that can't wait in the outbox.
const NEEDS_SERVER = new Set([
  'convertNote', 'deleteNoteForever', 'emptyTrash', 'importNotes', 'restoreVersion', 'getVersions',
  'createLabel', 'updateLabel', 'deleteLabel', 'reorderLabels',
  'addAttachments', 'deleteAttachment', 'updateAttachment', 'getAttachmentDrawing',
  'uploadImage', 'uploadFile', 'uploadAudio',
  'getMembers', 'addMember', 'updateMember', 'removeMember',
]);

/** { online, pending, syncing, error } for the sidebar and the offline bar. */
export const offlineState = writable({ online: typeof navigator === 'undefined' ? true : navigator.onLine !== false, pending: 0, syncing: false, error: null });

// ── IndexedDB ────────────────────────────────────────────────────────
let _dbPromise = null;
function _dbName() {
  let user = null;
  try { user = localStorage.getItem('wl:userId'); } catch { /* private mode */ }
  return `notetrace-offline-${user || 'single'}`;
}
function _db() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  const name = _dbName();
  if (_dbPromise && _dbPromise.name === name) return _dbPromise;
  const p = new Promise((resolve) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  p.name = name;
  _dbPromise = p;
  return p;
}
function _tx(store, mode, fn) {
  return _db().then(db => new Promise((resolve) => {
    if (!db) return resolve(null);
    let out;
    try {
      const tx = db.transaction(store, mode);
      out = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
      tx.onerror = tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}
const _all = (store) => _tx(store, 'readonly', s => s.getAll()).then(r => r || []);
const _meta = (key) => _tx('meta', 'readonly', s => s.get(key));
const _setMeta = (key, value) => _tx('meta', 'readwrite', s => s.put(value, key));

// ── Mirror and outbox ────────────────────────────────────────────────
let _ops = null;
async function _loadOps() {
  if (!_ops) _ops = await _all('outbox');
  return _ops;
}
async function _idMap() { return (await _meta('idMap')) || {}; }
const _mapId = (map, id) => (isTempId(Number(id)) && map[Number(id)] ? map[Number(id)] : Number(id));

async function remember(notes) {
  const list = (Array.isArray(notes) ? notes : [notes]).filter(n => n && typeof n.id === 'number' && n.kind);
  if (!list.length) return;
  await _tx('notes', 'readwrite', s => { for (const n of list) s.put(n); });
}

function _publish(extra = {}) {
  offlineState.update(s => ({ ...s, pending: _ops?.length || 0, ...extra }));
}

const _channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('notetrace-offline') : null;
_channel?.addEventListener('message', async (e) => {
  if (e.data?.type !== 'outbox') return;
  _ops = null;
  await _loadOps();
  _publish();
  if (e.data.synced) window.dispatchEvent(new CustomEvent('note:offline-synced', { detail: e.data.synced }));
});

function _offlineError() {
  const t = get(_);
  const err = new Error(typeof t === 'function' ? t('offline.needs_connection') : 'This needs a connection');
  err.offline = true;
  return err;
}

const _online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

async function _localNotes() {
  const [mirror, ops] = await Promise.all([_all('notes'), _loadOps()]);
  return [...applyOps(mirror, ops).values()];
}

async function queue(op) {
  op.at = Date.now();
  // Loaded before the add, so the new op isn't read back and then pushed twice.
  const ops = await _loadOps();
  if (op.type !== 'create' && !applyOps(await _all('notes'), ops).has(op.id)) throw _offlineError();
  const seq = await _tx('outbox', 'readwrite', s => s.add(op));
  if (seq == null) throw _offlineError();
  op.seq = seq;
  ops.push(op);
  _publish();
  _channel?.postMessage({ type: 'outbox' });
  // While the server is unreachable, retry on a timer rather than on every keystroke's save.
  _scheduleFlush(get(offlineState).online && _online() ? 0 : _retryMs);
  return (await _localNotes()).find(n => n.id === op.id) || null;
}

// ── Sending the outbox ───────────────────────────────────────────────
let _http = null;
let _retry = null;
let _flushing = null;

function _scheduleFlush(ms = 0) {
  clearTimeout(_retry);
  _retry = setTimeout(() => { flushOutbox(); }, ms);
}

/** Send what's waiting. Resolves true when the outbox is empty afterwards. */
export function flushOutbox() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    try {
      const run = async () => _flushOnce();
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request('notetrace-offline-flush', run);
      }
      return await run();
    } finally {
      _flushing = null;
    }
  })();
  return _flushing;
}

async function _flushOnce() {
  _ops = null;
  const ops = await _loadOps();
  if (!ops.length) { _publish({ syncing: false, error: null }); return true; }
  if (!_online() || !_http) { _scheduleFlush(_backoff()); return false; }
  _publish({ syncing: true });
  const mirror = await _all('notes');
  const base = new Map(mirror.map(n => [n.id, n]));
  const final = applyOps(mirror, ops);
  const payload = buildPush(ops, base, final);
  let response;
  try {
    response = await _http.post('/api/sync/push', payload);
  } catch (err) {
    _publish({ syncing: false, error: isOfflineError(err) ? null : (err.message || 'failed'), online: _online() && !isOfflineError(err) });
    _scheduleFlush(_backoff());
    return false;
  }
  const failed = Object.values(response?.tables || {}).find(r => r && !Array.isArray(r) && r.error);
  if (failed) {
    _publish({ syncing: false, error: failed.error, online: true });
    _scheduleFlush(_backoff());
    return false;
  }

  // Sent: those ops are done. Notes made offline now have server ids.
  const created = createdIds(response);
  const map = { ...(await _idMap()), ...created };
  await _setMeta('idMap', map);
  const sent = new Set(ops.map(o => o.seq));
  await _tx('outbox', 'readwrite', s => { for (const seq of sent) s.delete(seq); });
  // Edits made while the push was out still point at the old ids.
  const rest = (await _all('outbox')).filter(o => !sent.has(o.seq));
  const remapped = rest.filter(o => created[o.id]);
  if (remapped.length) await _tx('outbox', 'readwrite', s => { for (const o of remapped) s.put({ ...o, id: created[o.id] }); });
  _ops = null;
  await _loadOps();

  // Fresh copies from the server replace the offline ones.
  const ids = [...touchedIds(ops)].map(id => _mapId(map, id));
  await _tx('notes', 'readwrite', s => { for (const id of touchedIds(ops)) if (isTempId(id)) s.delete(id); });
  for (const id of ids) {
    try { await remember(await _http.get(`/api/notes/${id}`)); }
    catch { /* gone on the server: the next list refresh drops it */ }
  }
  _retryMs = RETRY_MIN_MS;
  _publish({ syncing: false, error: null, online: true });
  const detail = { created };
  _channel?.postMessage({ type: 'outbox', synced: detail });
  window.dispatchEvent(new CustomEvent('note:offline-synced', { detail }));
  if (_ops.length) _scheduleFlush();
  return !_ops.length;
}

// Notes the server no longer lists for a whole view (deleted or moved on another
// device) leave the mirror, unless an edit here is still waiting for them.
async function _prune(serverList, query) {
  const ids = new Set((serverList || []).map(n => n.id));
  const waiting = touchedIds(await _loadOps());
  const stale = listView(await _all('notes'), { view: query.view || 'notes' })
    .filter(n => !ids.has(n.id) && !waiting.has(n.id)).map(n => n.id);
  if (stale.length) await _tx('notes', 'readwrite', s => { for (const id of stale) s.delete(id); });
}

/** Signed out: this account's offline copy and anything unsent go. */
export async function clearOfflineData() {
  _ops = [];
  _publish({ pending: 0 });
  try {
    const db = await _db();
    db?.close();
    _dbPromise = null;
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(_dbName());
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  } catch { /* nothing stored */ }
}

/** How many edits are waiting to go up. */
export async function pendingCount() {
  return (await _loadOps()).length;
}

// ── The API ──────────────────────────────────────────────────────────
export function createOfflineApi(http) {
  _http = http;
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { _retryMs = RETRY_MIN_MS; offlineState.update(s => ({ ...s, online: true })); _scheduleFlush(); });
    // Coming back to the tab is a good moment to try again.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && _ops?.length) _scheduleFlush(); });
    window.addEventListener('offline', () => offlineState.update(s => ({ ...s, online: false })));
    _loadOps().then((ops) => { _publish(); if (ops.length) _scheduleFlush(1500); });
  }

  // A read: the server when it answers (with waiting edits laid over it), else the mirror.
  async function read(fromServer, fromLocal, overlay) {
    const ops = await _loadOps();
    if (_online()) {
      try {
        const result = await fromServer();
        offlineState.update(s => (s.online ? s : { ...s, online: true }));
        if (ops.length) _scheduleFlush();
        return ops.length && overlay ? overlay(result, ops) : result;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        offlineState.update(s => ({ ...s, online: false }));
      }
    }
    return fromLocal();
  }

  // A note edit: straight to the server, or into the outbox when it can't be reached
  // (or when earlier edits are still waiting, so they go up in order).
  async function write(op, send) {
    const ops = await _loadOps();
    if (!ops.length && _online()) {
      try {
        const result = await send();
        await remember(result);
        return result;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        offlineState.update(s => ({ ...s, online: false }));
      }
    }
    return queue(op);
  }

  const api = {
    async getNotes(query = {}) {
      return read(
        async () => {
          const list = await http.getNotes(query);
          await remember(list);
          if (!query.label && !query.q && !query.kind) await _prune(list, query);
          return list;
        },
        async () => listView(await _localNotes(), query),
        async (list, ops) => overlayList(list, ops, query, await _all('notes')),
      );
    },
    async getNote(id) {
      const map = await _idMap();
      const real = _mapId(map, id);
      const local = async () => (await _localNotes()).find(n => n.id === real || n.id === Number(id)) || Promise.reject(_offlineError());
      if (isTempId(real)) return local();
      return read(
        async () => { const n = await http.getNote(real); await remember(n); return n; },
        local,
        async (n, ops) => applyOps([n], ops).get(n.id) || n,
      );
    },
    async getNoteCounts(today) {
      return read(() => http.getNoteCounts(today), async () => ({ tasksDue: tasksDueCount(await _localNotes(), today), today }));
    },
    async getLabels() {
      return read(
        async () => { const rows = await http.getLabels(); await _setMeta('labels', rows); return rows; },
        async () => (await _meta('labels')) || [],
      );
    },
    async getNoteTitles() {
      return read(() => http.getNoteTitles(), async () => (await _localNotes())
        .filter(n => !n.trashed_at && String(n.title || '').trim())
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .map(n => ({ id: n.id, title: n.title })));
    },
    async findNoteByTitle(title) {
      return read(() => http.findNoteByTitle(title), async () => {
        const want = String(title || '').trim().toLowerCase();
        return (await _localNotes()).find(n => !n.trashed_at && String(n.title || '').trim().toLowerCase() === want) || null;
      });
    },
    async getBacklinks(noteId) {
      const real = _mapId(await _idMap(), noteId);
      if (isTempId(real)) return [];
      return read(() => http.getBacklinks(real), async () => []);
    },

    async createNote(data = {}) {
      if (Array.isArray(data.attachments) && data.attachments.length) return http.createNote(data);
      const id = -(Date.now() * 100 + Math.floor(Math.random() * 100));
      return write({ type: 'create', id, note: data }, () => http.createNote(data));
    },
    async updateNote(id, patch = {}) {
      const real = _mapId(await _idMap(), id);
      const offlinePatch = {};
      for (const k of [...NOTE_FIELDS, 'labels']) if (k in patch) offlinePatch[k] = patch[k];
      // Renaming [[links]] across notes, or a kind change, needs the server.
      const serverOnly = 'kind' in patch || ('rename_links_from' in patch);
      if (serverOnly && !Object.keys(offlinePatch).length) {
        if (isTempId(real)) return (await _localNotes()).find(n => n.id === real) || null;
        return http.updateNote(real, patch);
      }
      return write({ type: 'update', id: real, patch: offlinePatch }, () => http.updateNote(real, patch));
    },
    async trashNote(id) {
      const real = _mapId(await _idMap(), id);
      return write({ type: 'trash', id: real }, () => http.trashNote(real));
    },
    async restoreNote(id) {
      const real = _mapId(await _idMap(), id);
      return write({ type: 'restore', id: real }, () => http.restoreNote(real));
    },
    async addItem(noteId, data = {}) {
      const real = _mapId(await _idMap(), noteId);
      return write({ type: 'addItem', id: real, item: data }, () => http.addItem(real, data));
    },
    async updateItem(noteId, uuid, patch = {}) {
      const real = _mapId(await _idMap(), noteId);
      return write({ type: 'updateItem', id: real, uuid, patch }, () => http.updateItem(real, uuid, patch));
    },
    async deleteItem(noteId, uuid) {
      const real = _mapId(await _idMap(), noteId);
      return write({ type: 'deleteItem', id: real, uuid }, () => http.deleteItem(real, uuid));
    },
    async reorderItems(noteId, uuids) {
      const real = _mapId(await _idMap(), noteId);
      return write({ type: 'reorderItems', id: real, uuids }, () => http.reorderItems(real, uuids));
    },
  };

  return new Proxy(api, {
    get(target, prop) {
      if (prop in target) return target[prop];
      const value = http[prop];
      if (typeof value !== 'function') return value;
      if (!NEEDS_SERVER.has(prop)) return value.bind(http);
      // Server work on a note made offline waits for its real id.
      return async (...args) => {
        if (typeof args[0] === 'number' || /^-?\d+$/.test(String(args[0] ?? ''))) {
          const real = _mapId(await _idMap(), args[0]);
          if (isTempId(real)) throw _offlineError();
          args[0] = real;
        }
        if (!_online()) throw _offlineError();
        try {
          return await value.apply(http, args);
        } catch (err) {
          if (isOfflineError(err)) throw _offlineError();
          throw err;
        }
      };
    },
  });
}

