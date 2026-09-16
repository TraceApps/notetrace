/**
 * api-native.js: NoteTrace API impl backed by local SQLite for native
 * standalone mode. Provides the same interface as NoteApi in api.js, but
 * every read/write hits the on-device SQLite database created in
 * db-native.js instead of an HTTP server.
 *
 * Active when running on Capacitor AND no server URL is configured.
 * In server-connected native mode the cached impl (api-cached.js) wraps
 * the same local DB with a sync layer.
 *
 * Single-user semantics (LOCAL_USER_ID = 1): multi-user and sharing
 * features are no-ops or throw "requires server" in local mode.
 */

import { getDb, LOCAL_USER_ID } from './db-native.js';
import { NotesNative } from './notes-native.js';
import { Filesystem, Directory } from '@capacitor/filesystem';

// ── Small utilities ──────────────────────────────────────────────────

function _parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function _stringify(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function _bool(v) { return v ? 1 : 0; }

async function _query(sql, params = []) {
  const db = await getDb();
  const r = await db.query(sql, params);
  return r?.values || [];
}
async function _run(sql, params = []) {
  const db = await getDb();
  return db.run(sql, params);
}
async function _runInsert(sql, params = []) {
  const db = await getDb();
  const r = await db.run(sql, params);
  return r?.changes?.lastId ?? r?.lastId ?? null;
}

// Convert a File / Blob to base64 (sans the data: URL prefix) so it
// can be handed to Filesystem.writeFile.
function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const r = String(reader.result || '');
      const i = r.indexOf(',');
      resolve(i >= 0 ? r.slice(i + 1) : r);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── NoteApi native implementation ────────────────────────────────────

export const NoteApiNative = {

  // Notes, checklist items, versions, labels: see notes-native.js.
  ...NotesNative,

  // ── AI chat history ────────────────────────────────────────────────

  async getAiChatHistory() {
    return _query(
      `SELECT * FROM ai_chat_history WHERE user_id = ? ORDER BY created_at ASC`,
      [LOCAL_USER_ID]
    );
  },
  async appendAiChat(role, content) {
    await _runInsert(
      `INSERT INTO ai_chat_history (user_id, role, content, sync_status) VALUES (?, ?, ?, 'pending')`,
      [LOCAL_USER_ID, role, content]
    );
    return { ok: true };
  },
  async clearAiChat() {
    await _run(`DELETE FROM ai_chat_history WHERE user_id = ?`, [LOCAL_USER_ID]);
    return { ok: true };
  },

  // ── Multi-user / sharing stubs ─────────────────────────────────────
  // Local mode is inherently single-user, so these return results that
  // let the UI guards collapse cleanly.

  async getUsersList()             { return [{ id: LOCAL_USER_ID, username: 'local', role: 'admin' }]; },
  async getAppConfig()             { return { sharing_enabled: false, user_mgmt_active: false }; },

  // Low-level helpers used by Settings sub-components for endpoints
  // that don't have a dedicated wrapper (e.g. /api/health). In local
  // mode they refuse politely instead of bombing with "not a function".
  async get(path)   { throw new Error(`Local mode: ${path} is server-only`); },
  async post(path)  { throw new Error(`Local mode: ${path} is server-only`); },
  async del(path)   { throw new Error(`Local mode: ${path} is server-only`); },

  // ── Image upload via Filesystem ────────────────────────────────────

  // Local-mode imports store their images on the device, like any upload.
  importUploadImage(file) { return this.uploadImage(file); },
  importUploadFile(file) { return this.uploadFile(file); },
  importUpdateAttachment(noteId, uuid, patch) { return NotesNative.updateAttachment(noteId, uuid, patch); },

  async uploadImage(file) {
    const base64 = await _fileToBase64(file);
    const safe = String(file?.name || 'image').replace(/[^a-zA-Z0-9.]/g, '_');
    const fileName = `img_${Date.now()}_${safe}`;
    await Filesystem.writeFile({
      path: `uploads/${fileName}`,
      data: base64,
      directory: Directory.Data,
      recursive: true,
    });
    const { uri } = await Filesystem.getUri({
      path: `uploads/${fileName}`,
      directory: Directory.Data,
    });
    // Store the WebView-safe URL rather than the raw file:// URI. Android
    // WebView blocks file:// even after resolveAssetUrl's convertFileSrc
    // pass under some scheme configurations (previously-uploaded photos
    // stayed rendered because their URIs came from image-cache's
    // already-converted mapping; freshly uploaded ones hit an unconverted
    // path and 404'd). Converting at upload time means the stored value is
    // https://localhost/_capacitor_file_/... and every render site works
    // without depending on the runtime pass.
    const { Capacitor: CapCore } = await import('@capacitor/core');
    return (CapCore && typeof CapCore.convertFileSrc === 'function')
      ? CapCore.convertFileSrc(uri)
      : uri;
  },

  /** Any file for a note, kept on the phone until sync uploads it: { url, mime, size }. */
  async uploadFile(file) {
    const base64 = await _fileToBase64(file);
    // The extension stays at the end: the sync upload pass reads the type from it.
    const safe = String(file?.name || 'file').replace(/[^a-zA-Z0-9.]/g, '_').slice(-120);
    const fileName = `file_${Date.now()}_${safe}`;
    await Filesystem.writeFile({ path: `uploads/${fileName}`, data: base64, directory: Directory.Data, recursive: true });
    const { uri } = await Filesystem.getUri({ path: `uploads/${fileName}`, directory: Directory.Data });
    const { Capacitor: CapCore } = await import('@capacitor/core');
    const url = (CapCore && typeof CapCore.convertFileSrc === 'function') ? CapCore.convertFileSrc(uri) : uri;
    return { url, mime: file?.type || 'application/octet-stream', size: file?.size ?? null };
  },
};
