/**
 * migrate.js: local to server data migration on first connect.
 *
 * Called from SettingsServerConnection.svelte when the user is leaving
 * local-only mode for a server. If local SQLite has data from prior
 * offline use, surface counts so the user picks:
 *   upload:   push local rows to the server, server keeps its data
 *   download: wipe local first, then let the post-reload sync pull
 *             everything down from the server
 *   merge:    push local rows, then pull on reload
 *
 * Notes upload through the regular sync push: every local row is reset
 * to server_id NULL + sync_status 'pending', so the first sync after the
 * reload inserts them server-side. Settings go through the bulk endpoint.
 */

import { CapacitorHttp } from '@capacitor/core';
import { isNative } from './platform.js';

const DOMAIN_TABLES = ['notes'];

/**
 * Count local rows that would be uploaded. Fast, no network. Returns
 * `{ notes, settings, total }`.
 */
export async function countLocalData() {
  if (!isNative) return _empty();
  try {
    const { getDb } = await import('./db-native.js');
    const db = await getDb();
    const r = await db.query(`SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL`, []);
    const notes = r?.values?.[0]?.n || 0;
    let settings = 0;
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        if (/^wl_u\d+_/.test(localStorage.key(i) || '')) settings++;
      }
    }
    return { notes, settings, total: notes + settings };
  } catch {
    return _empty();
  }
}

/**
 * Queue every local row for upload and push settings. Returns
 * `{ success: { notes, settings }, errors: [{ stage, name, message }],
 *    total, totalSuccess }`.
 *
 * onProgress(stage, current, total) is called so the dialog can render
 * progress. `stage` is one of: 'notes', 'settings'.
 */
export async function uploadLocalToServer({ serverUrl, authToken, onProgress } = {}) {
  const summary = {
    success: { notes: 0, settings: 0 },
    errors: [],
    total: 0,
    totalSuccess: 0,
  };
  if (!isNative || !serverUrl) return summary;
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  try {
    const { getDb } = await import('./db-native.js');
    const db = await getDb();
    for (const t of DOMAIN_TABLES) {
      onProgress?.(t, 0, 1);
      const r = await db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE deleted_at IS NULL`, []);
      await db.run(`UPDATE ${t} SET server_id = NULL, sync_status = 'pending'`, []);
      summary.success[t] = r?.values?.[0]?.n || 0;
      onProgress?.(t, 1, 1);
    }
  } catch (e) {
    summary.errors.push({ stage: 'notes', name: '(queue for upload)', message: e.message });
  }

  // ── Settings (bulk endpoint — one round-trip) ───────────────────────────
  try {
    const settings = {};
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !/^wl_u\d+_/.test(k)) continue;
        const userKey = k.replace(/^wl_u\d+_/, '');
        const raw = localStorage.getItem(k);
        let value;
        try { value = JSON.parse(raw); } catch { value = raw; }
        settings[userKey] = value;
      }
    }
    const keys = Object.keys(settings);
    if (keys.length > 0) {
      onProgress?.('settings', 0, keys.length);
      await _put(`${serverUrl}/api/settings/bulk`, headers, { settings });
      summary.success.settings += keys.length;
      onProgress?.('settings', keys.length, keys.length);
    }
  } catch (e) {
    summary.errors.push({ stage: 'settings', name: '(bulk upsert)', message: e.message });
  }

  for (const k of Object.keys(summary.success)) {
    summary.totalSuccess += summary.success[k];
    summary.total        += summary.success[k];
  }
  summary.total += summary.errors.length;
  return summary;
}

/**
 * Wipe every local row across the user-facing tables. Used by the
 * "download server to phone" path so the post-reload sync starts from
 * a clean local slate and pulls in the server's state authoritatively.
 * Returns the number of rows touched (best-effort).
 */
export async function wipeLocalData() {
  if (!isNative) return 0;
  const { getDb } = await import('./db-native.js');
  const db = await getDb();
  let touched = 0;
  for (const t of DOMAIN_TABLES) {
    try {
      const r = await db.run(`DELETE FROM ${t}`);
      touched += r?.changes?.changes || 0;
    } catch { /* table may not exist on older installs */ }
  }
  // Blow away local user-scoped settings so the server's win on reload.
  if (typeof localStorage !== 'undefined') {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /^wl_u\d+_/.test(k)) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  }
  return touched;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function _empty() {
  return { notes: 0, settings: 0, total: 0 };
}

async function _put(url, headers, body)  { return _request('PUT',  url, headers, body); }
// CapacitorHttp bypasses WebView CORS for the external server origin.
async function _request(method, url, headers, body) {
  const res = await CapacitorHttp.request({
    method, url, headers,
    data: body || {},
  });
  if (res.status < 200 || res.status >= 300) {
    let msg = `${method} ${url} → ${res.status}`;
    const data = typeof res.data === 'string'
      ? (() => { try { return JSON.parse(res.data); } catch { return null; } })()
      : res.data;
    if (data?.error) msg = data.error;
    throw new Error(msg);
  }
  return typeof res.data === 'string'
    ? (() => { try { return JSON.parse(res.data); } catch { return null; } })()
    : res.data;
}
