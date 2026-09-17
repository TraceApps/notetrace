/**
 * cooktrace.js: the CookTrace shopping list, from NoteTrace.
 *
 * Each user links their own CookTrace with its address and an API token
 * made in CookTrace (Settings, API Tokens, with the shopping scope). The
 * token is stored encrypted and never leaves this server: the browser and
 * the phone call NoteTrace, and NoteTrace calls CookTrace's shopping API
 * (/api/v1/shopping) to list, add, check off, and clear items. CookTrace
 * needs no server setting for it.
 *
 * CookTrace on a private address (a LAN IP, localhost, a Docker network
 * name) needs ALLOW_PRIVATE_COOKTRACE_URLS=1 here.
 */
import db from '../db.js';
import { encrypt, decrypt } from './token-crypto.js';
import { assertSafeUrl } from './ssrf-guard.js';
import { normalizeCooktraceUrl } from './cooktrace-core.js';

const URL_KEY = 'cooktraceUrl';
const TOKEN_KEY = 'cooktraceToken';
const ENABLED_KEY = 'cooktraceEnabled';
const TIMEOUT_MS = 15_000;

function _envFlag(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}
const ALLOW_PRIVATE = () => _envFlag(process.env.ALLOW_PRIVATE_COOKTRACE_URLS);

// ── Stored link (per user; app_config when there are no user accounts) ──

function _get(userId, key) {
  const row = userId == null
    ? db.prepare('SELECT value FROM app_config WHERE key = ?').get(`user:${key}`)
    : db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ? AND deleted_at IS NULL').get(userId, key);
  if (row?.value == null) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function _set(userId, key, value) {
  const json = JSON.stringify(value);
  if (userId == null) {
    db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`user:${key}`, json);
  } else {
    db.prepare(`INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), deleted_at = NULL`).run(userId, key, json);
  }
}

function _del(userId, key) {
  if (userId == null) db.prepare('DELETE FROM app_config WHERE key = ?').run(`user:${key}`);
  else db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
}

/** The link without the token, for Settings. */
export function getLink(userId) {
  const url = _get(userId, URL_KEY);
  const token = _get(userId, TOKEN_KEY);
  const enabled = _get(userId, ENABLED_KEY);
  if (!url || !token) return { connected: false, enabled: enabled === true };
  const info = _get(userId, 'cooktraceInfo') || {};
  // A link made before the switch existed counts as on.
  return { connected: true, enabled: enabled !== false, url, username: info.username || null, can_add: info.can_add !== false };
}

/** Turn the link on or off without forgetting it. Off hides Shopping and Send to CookTrace. */
export function setEnabled(userId, enabled) {
  _set(userId, ENABLED_KEY, !!enabled);
  return getLink(userId);
}

function _config(userId) {
  const url = _get(userId, URL_KEY);
  const enc = _get(userId, TOKEN_KEY);
  if (!url || !enc) return null;
  let token;
  try { token = decrypt(enc); } catch { return null; }
  return token ? { url, token } : null;
}

export function unlink(userId) {
  for (const k of [URL_KEY, TOKEN_KEY, 'cooktraceInfo']) _del(userId, k);
}

// ── Calls to CookTrace ──────────────────────────────────────────────────

export class CooktraceError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

async function _fetch(url, opts = {}) {
  await assertSafeUrl(url, { allowPrivate: ALLOW_PRIVATE(), allowPrivateEnvHint: 'ALLOW_PRIVATE_COOKTRACE_URLS' })
    .catch(e => { throw new CooktraceError(e.message, 400); });
  try {
    return await fetch(url, { ...opts, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new CooktraceError('CookTrace didn\'t answer in time.');
    throw new CooktraceError('Couldn\'t reach CookTrace at that address.');
  }
}

async function _me(url, token) {
  const res = await _fetch(`${url}/api/v1/me`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (res.status === 401) throw new CooktraceError('CookTrace didn\'t accept that token.', 400);
  if (res.status === 429) throw new CooktraceError('CookTrace is rate limiting this token. Try again in a minute.', 429);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.user) throw new CooktraceError('That address doesn\'t look like a CookTrace server.', 400);
  return data;
}


/** A call to CookTrace's shopping API with the saved token. Throws CooktraceError with a message for people. */
async function _shopping(cfg, method, path = '', body) {
  const res = await _fetch(`${cfg.url}/api/v1/shopping${path}`, {
    method,
    headers: { Accept: 'application/json', Authorization: `Bearer ${cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new CooktraceError('CookTrace didn\'t accept the saved token. Link CookTrace again in Settings.', 400);
  if (res.status === 403) throw new CooktraceError('The CookTrace token needs the shopping scope.', 400);
  // The list itself missing (not one item) means a CookTrace from before the shopping API.
  if (res.status === 404 && (!path || path.startsWith('?'))) throw new CooktraceError('This CookTrace is too old for NoteTrace. Update CookTrace, then link it again.', 400);
  if (res.status === 429) throw new CooktraceError('CookTrace is rate limiting this token. Try again in a minute.', 429);
  const data = await res.json().catch(() => null);
  if (res.status === 404) throw new CooktraceError(data?.error || 'That item isn\'t on the CookTrace list any more.', 404);
  if (!res.ok || !data) throw new CooktraceError(data?.error || `CookTrace answered with an error (${res.status}).`);
  return data;
}

function _required(userId) {
  const cfg = _config(userId);
  if (!cfg) throw new CooktraceError('Link CookTrace in Settings first.', 409);
  return cfg;
}

/**
 * Check a URL and token, then save them. Returns the link for Settings.
 * No token reuses the saved one, but only for the saved address: the token
 * never goes to an address it wasn't linked with.
 */
export async function link(userId, { url: rawUrl, token: rawToken }) {
  const url = normalizeCooktraceUrl(rawUrl);
  let token = String(rawToken || '').trim();
  if (!url) throw new CooktraceError('Enter the CookTrace address, starting with http:// or https://.', 400);
  if (!token) {
    const saved = _config(userId);
    if (saved && saved.url !== url) throw new CooktraceError('Enter the API token again for the new address.', 400);
    token = saved?.token || '';
  }
  if (!token) throw new CooktraceError('Enter a CookTrace API token.', 400);
  await _check(url, token, userId);
  _set(userId, ENABLED_KEY, true);
  return getLink(userId);
}

/** Check the saved link still works (the Test button). Returns the link, or throws why not. */
export async function test(userId) {
  const cfg = _required(userId);
  await _check(cfg.url, cfg.token, userId);
  return getLink(userId);
}

async function _check(url, token, userId) {
  const me = await _me(url, token);
  const scopes = Array.isArray(me.scopes) ? me.scopes : [];
  if (!scopes.includes('shopping')) throw new CooktraceError('The CookTrace token needs the shopping scope.', 400);
  // Proves this CookTrace has the shopping API, not just that the token is valid.
  await _shopping({ url, token }, 'GET', '?include_checked=false');
  _set(userId, URL_KEY, url);
  _set(userId, TOKEN_KEY, encrypt(token));
  _set(userId, 'cooktraceInfo', { username: me.user.username || null, can_add: true });
}

/** The CookTrace shopping list, sorted as CookTrace shows it. { items } */
export async function listShopping(userId) {
  const data = await _shopping(_required(userId), 'GET', '?include_checked=true');
  return { items: Array.isArray(data.items) ? data.items : [] };
}

/** Add names (or { name, quantity, unit }) in one call. { added, skipped } counts and items. */
export async function addToShoppingList(userId, entries) {
  const items = entries.map(e => (typeof e === 'string' ? { name: e } : e));
  const data = await _shopping(_required(userId), 'POST', '', { items });
  return { added: data.added || [], skipped: data.skipped || [] };
}

export async function checkShoppingItem(userId, id, checked) {
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n) || n <= 0) throw new CooktraceError('Invalid item.', 400);
  return _shopping(_required(userId), 'PATCH', `/${n}/check`, { checked: !!checked });
}

export async function clearCheckedShopping(userId) {
  return _shopping(_required(userId), 'DELETE', '/checked');
}
