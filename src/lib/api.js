/**
 * api.js — NoteTrace server API.
 *
 * Three impls behind a single proxy:
 *   - HTTP (web PWA, or native + server URL)         → _NoteApiHttp
 *   - Local SQLite (native standalone, no server)    → NoteApiNative
 *   - Cached HTTP with local fallback (native+server) → NoteApiCached
 */

import { isNative, getServerUrl, getAuthToken, resolveAssetUrl, apiUrl } from './platform.js';

// Build the auth-related headers a mutating request needs. Callers
// that bypass NoteApi._fetch (multipart FormData uploads via a raw
// fetch(), like the file-import dialogs) still need Bearer on native
// AND X-CSRF-Token on PWA — dropping either produces "Invalid CSRF
// token" 403s on the PWA (issue #43) or 401s on native standalone.
// Prefer this helper over hand-rolling the pattern per call site.
function _mutatingAuthHeaders() {
  const h = {};
  if (isNative && getServerUrl()) {
    const token = getAuthToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
  } else if (!isNative) {
    const csrf = typeof localStorage !== 'undefined' ? localStorage.getItem('note:csrf') : null;
    if (csrf) h['X-CSRF-Token'] = csrf;
  }
  return h;
}

const _NoteApiHttp = {
  async _fetch(method, path, body, isUpload = false) {
    const headers = {};
    if (!isUpload) headers['Content-Type'] = 'application/json';

    if (isNative && getServerUrl()) {
      const token = getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    if (!isNative && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrf = localStorage.getItem('note:csrf');
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }

    const res = await fetch(apiUrl(path), {
      method,
      headers,
      credentials: 'include',
      cache: 'no-store',
      body: isUpload ? body : body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      const err = new Error(e.error || `API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  },

  get(path)         { return this._fetch('GET',    path); },
  post(path, body)  { return this._fetch('POST',   path, body); },
  put(path, body)   { return this._fetch('PUT',    path, body); },
  patch(path, body) { return this._fetch('PATCH',  path, body); },
  del(path)         { return this._fetch('DELETE', path); },

  // XHR-based POST that surfaces upload progress. fetch() can't tell
  // us how many bytes have left the device on a multipart upload, but
  // XHR's upload.onprogress can. We use this for bulk zip imports so
  // the UI can show "Uploading 42%" → "Scanning…" instead of a long
  // mystery wait.
  //
  // Also includes stall detection: if no progress event fires for
  // STALL_TIMEOUT_MS while we're still uploading, abort with a clear
  // error so the user isn't stuck staring at "Uploading 1%" forever
  // when a reverse proxy silently cut the connection.
  _postFormWithProgress(path, formData, { onProgress } = {}) {
    const STALL_TIMEOUT_MS = 45_000;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl(path), true);
      xhr.withCredentials = true;
      // Same auth scheme as _fetch: Bearer for native+server, CSRF
      // header for cookie-authed PWA.
      if (isNative && getServerUrl()) {
        const token = getAuthToken();
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      } else if (!isNative) {
        const csrf = typeof localStorage !== 'undefined' ? localStorage.getItem('note:csrf') : null;
        if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
      }

      let stallTimer = null;
      let uploadDone = false;
      const resetStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        if (uploadDone) return;
        stallTimer = setTimeout(() => {
          try { xhr.abort(); } catch {}
          reject(new Error(`Upload stalled — no progress in ${Math.round(STALL_TIMEOUT_MS / 1000)}s. A reverse proxy may have cut the connection (check Nginx client_max_body_size or your CDN body limits).`));
        }, STALL_TIMEOUT_MS);
      };
      resetStall();

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          try { onProgress?.({ loaded: ev.loaded, total: ev.total, percent: Math.round((ev.loaded / ev.total) * 100) }); } catch {}
        }
        resetStall();
      };
      // Once the upload finishes the server is processing — emit a
      // sentinel so the UI can switch from "Uploading" to "Scanning".
      xhr.upload.onload = () => {
        uploadDone = true;
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        try { onProgress?.({ loaded: 1, total: 1, percent: 100, uploaded: true }); } catch {}
      };
      xhr.onload = () => {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        const ct = xhr.getResponseHeader('content-type') || '';
        let body = null;
        if (/json/i.test(ct)) {
          try { body = JSON.parse(xhr.responseText); } catch {}
        }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(body ?? {});
        // Translate common proxy + server statuses into actionable messages.
        let msg = body?.error;
        if (!msg) {
          if (xhr.status === 413) msg = 'File too large for the server. The default cap is 512 MB; bump IMPORT_ZIP_MAX_MB or check your reverse-proxy body limits (Nginx client_max_body_size, Cloudflare upload cap, etc.).';
          else if (xhr.status === 502) msg = 'Server returned 502 Bad Gateway. Likely the upstream timed out reading the upload; try a smaller archive or raise proxy timeouts.';
          else if (xhr.status === 504) msg = 'Server returned 504 Gateway Timeout. The proxy gave up waiting for the upload to finish; try a smaller archive or raise proxy timeouts.';
          else if (xhr.status === 0)  msg = 'Connection closed by the network. Likely a proxy / CDN / firewall issue.';
          else msg = `API error ${xhr.status}`;
        }
        reject(new Error(msg));
      };
      xhr.onerror = () => {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        reject(new Error('Network error during upload (connection dropped or blocked).'));
      };
      xhr.onabort = () => {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        // If we already rejected via stall, this is a no-op.
        reject(new Error('Upload aborted'));
      };
      xhr.send(formData);
    });
  },

  // Image field mapping for any entity with an img_url column
  _imgFromApi(row) {
    if (!row) return null;
    const { img_url, ...rest } = row;
    return { ...rest, imgUrl: resolveAssetUrl(img_url) || '' };
  },
  _imgToApi(obj) {
    const { imgUrl, img_url, ...rest } = obj;
    return { ...rest, img_url: imgUrl || img_url || null };
  },

  // Notes
  getNotes({ view = 'notes', label = null, q = '', kind = null } = {}) {
    const p = new URLSearchParams();
    if (view !== 'notes') p.set('view', view);
    if (label != null) p.set('label', label);
    if (q) p.set('q', q);
    if (kind) p.set('kind', kind);
    const qs = p.toString();
    return this.get(`/api/notes${qs ? '?' + qs : ''}`);
  },
  // { tasksDue } for the sidebar badge; `today` is this device's date.
  getNoteCounts(today)           { return this.get(`/api/notes/counts?today=${encodeURIComponent(today)}`); },
  getNote(id)                    { return this.get(`/api/notes/${id}`); },
  createNote(data)               { return this.post('/api/notes', data); },
  updateNote(id, patch)          { return this.patch(`/api/notes/${id}`, patch); },
  convertNote(id, kind)          { return this.post(`/api/notes/${id}/convert`, { kind }); },
  trashNote(id)                  { return this.del(`/api/notes/${id}`); },
  restoreNote(id)                { return this.post(`/api/notes/${id}/restore`); },
  deleteNoteForever(id)          { return this.del(`/api/notes/${id}/forever`); },
  emptyTrash()                   { return this.del('/api/notes/trash'); },
  importNotes(notes)             { return this.post('/api/notes/import', { notes }); },

  // Checklist items
  addItem(noteId, data)          { return this.post(`/api/notes/${noteId}/items`, data); },
  updateItem(noteId, uuid, patch){ return this.patch(`/api/notes/${noteId}/items/${encodeURIComponent(uuid)}`, patch); },
  deleteItem(noteId, uuid)       { return this.del(`/api/notes/${noteId}/items/${encodeURIComponent(uuid)}`); },
  reorderItems(noteId, uuids)    { return this.put(`/api/notes/${noteId}/items/order`, { uuids }); },

  // Versions
  getVersions(noteId)            { return this.get(`/api/notes/${noteId}/versions`); },
  restoreVersion(noteId, vid)    { return this.post(`/api/notes/${noteId}/versions/${vid}/restore`); },

  // Labels
  getLabels()                    { return this.get('/api/labels'); },
  createLabel(data)              { return this.post('/api/labels', data); },
  updateLabel(id, data)          { return this.patch(`/api/labels/${id}`, data); },
  deleteLabel(id)                { return this.del(`/api/labels/${id}`); },
  reorderLabels(ids)             { return this.put('/api/labels/order', { ids }); },

  // [[Links]]
  getNoteTitles()                { return this.get('/api/notes/titles'); },
  findNoteByTitle(title)         { return this.get(`/api/notes/by-title?title=${encodeURIComponent(title)}`).catch(e => { if (/not found/i.test(e.message)) return null; throw e; }); },
  getBacklinks(noteId)           { return this.get(`/api/notes/${noteId}/backlinks`); },

  // Attachments (upload the file with uploadImage first)
  addAttachments(noteId, list)   { return this.post(`/api/notes/${noteId}/attachments`, { attachments: list }); },
  // Import follow-ups. importNotes runs on the server when one is connected
  // and returns server ids, so the images for those notes must go to the
  // server too: straight upload (no local fallback), attach by server id.
  importUploadImage(file)        { return this.uploadImage(file); },
  importUploadFile(file)         { return this.uploadFile(file); },
  importUpdateAttachment(noteId, uuid, patch) { return this.updateAttachment(noteId, uuid, patch); },
  importAddAttachments(noteId, list) { return this.addAttachments(noteId, list); },
  deleteAttachment(noteId, uuid) { return this.del(`/api/notes/${noteId}/attachments/${encodeURIComponent(uuid)}`); },
  updateAttachment(noteId, uuid, patch) { return this.patch(`/api/notes/${noteId}/attachments/${encodeURIComponent(uuid)}`, patch); },
  getAttachmentDrawing(noteId, uuid) { return this.get(`/api/notes/${noteId}/attachments/${encodeURIComponent(uuid)}/drawing`); },

  // Sharing
  getMembers(noteId)             { return this.get(`/api/notes/${noteId}/members`); },
  addMember(noteId, data)        { return this.post(`/api/notes/${noteId}/members`, data); },
  updateMember(noteId, uid, data){ return this.patch(`/api/notes/${noteId}/members/${uid}`, data); },
  removeMember(noteId, uid)      { return this.del(`/api/notes/${noteId}/members/${uid}`); },

  // Users (sharing picker)
  getUsersList()                 { return this.get('/api/auth/users/list'); },

  // App config
  getAppConfig()                 { return this.get('/api/app-config'); },

  // Upload
  // Your own profile. Through here rather than a raw fetch, so the offline
  // layer sees it and a picture chosen with no connection is kept until
  // there is one. Same shape in NutriTrace, LiftTrace and CookTrace.
  updateProfile(data)            { return this.put('/api/auth/profile', data); },

  async uploadImage(file) {
    const form = new FormData();
    form.append('file', file);
    const res = await this._fetch('POST', '/api/upload', form, true);
    return res.url;
  },
  /** Any file for a note: { url, mime, size }. */
  async uploadFile(file) {
    const form = new FormData();
    form.append('file', file);
    const res = await this._fetch('POST', '/api/upload', form, true);
    return { url: res.url, mime: res.mime || file.type || 'application/octet-stream', size: res.size ?? file.size ?? null };
  },
  /** Audio through the server, which can convert it to M4A: { url, mime, duration_ms }. */
  async uploadAudio(file, { convert = false } = {}) {
    const form = new FormData();
    form.append('file', file);
    return this._fetch('POST', `/api/upload/audio${convert ? '?convert=1' : ''}`, form, true);
  },
};

import { NoteApiNative } from './api-native.js';
import { NoteApiCached } from './api-cached.js';
import { createOfflineApi } from './offline-api.js';

// The web app: the server, with note edits kept and sent later when it can't be reached.
const _NoteApiWeb = isNative ? null : createOfflineApi(_NoteApiHttp);

// Endpoints without a local mirror in NoteApiNative: inherently
// server-scoped (sharing peers, user management, app config). In pure
// local mode NoteApiNative returns empty / no-op stubs so the UI guards
// collapse cleanly. In server-connected mode we bypass the stub and go
// straight to _NoteApiHttp so peer lists and User Management admin
// views reflect the server.
const SERVER_ONLY_METHODS = new Set([
  'getUsersList', 'getAppConfig',
  'getMembers', 'addMember', 'updateMember', 'removeMember',
  // Imports run on the server (keeping original dates) and reach this
  // device through sync.
  'importNotes', 'importUploadImage', 'importUploadFile', 'importUpdateAttachment', 'importAddAttachments', 'uploadAudio',
  // Low-level HTTP primitives, used by components that don't have a
  // dedicated NoteApi wrapper (invite list, session config, admin OIDC
  // CRUD, etc.). NoteApiNative stubs these to throw in pure local mode;
  // in server-connected mode they must actually reach the server.
  'get', 'post', 'put', 'patch', 'del',
]);

// Smart uploadImage for native connected mode. Tries the server first so
// the returned URL is a portable /uploads/<file> path that every device
// can render. Falls back to the native local-file path when the server
// upload fails (offline, transient network error, server down) — the
// diary/recipe/pantry entry can still save with a local URL, and the
// sync engine's stale-photo pass (sync.js → _reconcileLocalPhotoUrls)
// picks it up on the next successful sync, uploads it, and rewrites
// the URL in-place.
async function _uploadImageConnected(file) {
  try {
    return await _NoteApiHttp.uploadImage(file);
  } catch (e) {
    console.warn('[upload] server POST failed, saving locally for sync retry:', e?.message);
    return await NoteApiNative.uploadImage(file);
  }
}

// Files go the same way as photos: to the server when it answers, so the
// URL works on every device, else kept on the phone for sync to send later.
async function _uploadFileConnected(file) {
  try {
    return await _NoteApiHttp.uploadFile(file);
  } catch (e) {
    if (/larger than this server accepts/i.test(e?.message || '')) throw e;
    console.warn('[upload] server POST failed, saving the file locally for sync retry:', e?.message);
    return await NoteApiNative.uploadFile(file);
  }
}

// Dynamic proxy — picks the right impl per call based on platform mode.
export const NoteApi = new Proxy({}, {
  get(_, prop) {
    // Special-case uploadImage in native connected mode: server-first
    // with local fallback so photos land at portable /uploads/<file>
    // URLs that other devices can render, without breaking offline
    // photo-taking.
    if (prop === 'uploadImage' && isNative && getServerUrl()) {
      return _uploadImageConnected;
    }
    if (prop === 'uploadFile' && isNative && getServerUrl()) {
      return _uploadFileConnected;
    }
    let impl;
    if (!isNative)                                             impl = _NoteApiWeb;
    else if (!getServerUrl())                                  impl = NoteApiNative;
    else if (SERVER_ONLY_METHODS.has(prop))                    impl = _NoteApiHttp;
    else                                                       impl = NoteApiCached;
    const value = impl[prop];
    return typeof value === 'function' && impl !== _NoteApiWeb ? value.bind(impl) : value;
  },
});

// Public re-export for callers that need to hand-roll a fetch() (e.g.
// multipart uploads that can't ride through NoteApi._fetch). Use this
// instead of duplicating the CSRF / Bearer pattern per call site.
export const mutatingAuthHeaders = _mutatingAuthHeaders;
