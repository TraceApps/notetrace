/**
 * cooktrace.js: send checklist items to a CookTrace shopping list.
 *
 * Each user links their own CookTrace with its address and an API token
 * made in CookTrace (Settings, API Tokens, with the mcp:write scope). The
 * token is stored encrypted and never leaves this server: the browser and
 * the phone call NoteTrace, and NoteTrace calls CookTrace. Items go in
 * through CookTrace's MCP endpoint (add_shopping_item), so CookTrace needs
 * MCP_ENABLED=1 and MCP_WRITE_ENABLED=1. Nothing on the CookTrace side
 * changes for this.
 *
 * CookTrace on a private address (a LAN IP, localhost, a Docker network
 * name) needs ALLOW_PRIVATE_COOKTRACE_URLS=1 here.
 */
import db from '../db.js';
import { encrypt, decrypt } from './token-crypto.js';
import { assertSafeUrl } from './ssrf-guard.js';
import { normalizeCooktraceUrl, parseMcpReply } from './cooktrace-core.js';

const URL_KEY = 'cooktraceUrl';
const TOKEN_KEY = 'cooktraceToken';
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
  if (!url || !token) return { connected: false };
  const info = _get(userId, 'cooktraceInfo') || {};
  return { connected: true, url, username: info.username || null, can_add: info.can_add !== false };
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

let _rpcId = 0;
async function _mcp(url, token, method, params) {
  const res = await _fetch(`${url}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_rpcId, method, params }),
  });
  if (res.status === 404) throw new CooktraceError('MCP is off on this CookTrace. Set MCP_ENABLED=1 and MCP_WRITE_ENABLED=1 there.', 400);
  if (res.status === 401) throw new CooktraceError('CookTrace didn\'t accept the saved token. Link CookTrace again in Settings.', 400);
  if (res.status === 403) throw new CooktraceError('The CookTrace token needs the mcp:write scope.', 400);
  if (res.status === 429) throw new CooktraceError('CookTrace is rate limiting this token. Try again in a minute.', 429);
  const msg = parseMcpReply(await res.text());
  if (!res.ok || !msg) throw new CooktraceError(`CookTrace answered with an error (${res.status}).`);
  if (msg.error) {
    if (/not found|unknown tool/i.test(msg.error.message || '')) throw new CooktraceError('This CookTrace doesn\'t allow adding items. Set MCP_WRITE_ENABLED=1 there.', 400);
    throw new CooktraceError(msg.error.message || 'CookTrace answered with an error.');
  }
  return msg.result;
}

/** Check a URL and token, then save them. Returns the link for Settings. */
export async function link(userId, { url: rawUrl, token: rawToken }) {
  const url = normalizeCooktraceUrl(rawUrl);
  const token = String(rawToken || '').trim();
  if (!url) throw new CooktraceError('Enter the CookTrace address, starting with http:// or https://.', 400);
  if (!token) throw new CooktraceError('Enter a CookTrace API token.', 400);
  const me = await _me(url, token);
  const scopes = Array.isArray(me.scopes) ? me.scopes : [];
  if (!scopes.includes('mcp:write')) throw new CooktraceError('The CookTrace token needs the mcp:write scope.', 400);
  const tools = await _mcp(url, token, 'tools/list', {});
  const canAdd = (tools?.tools || []).some(t => t.name === 'add_shopping_item');
  if (!canAdd) throw new CooktraceError('This CookTrace doesn\'t allow adding items yet. Set MCP_WRITE_ENABLED=1 there.', 400);
  _set(userId, URL_KEY, url);
  _set(userId, TOKEN_KEY, encrypt(token));
  _set(userId, 'cooktraceInfo', { username: me.user.username || null, can_add: true });
  return getLink(userId);
}

/**
 * Add names to the CookTrace shopping list, one call each, in order.
 * Stops at the first failure and reports how many made it.
 */
export async function addToShoppingList(userId, names) {
  const cfg = _config(userId);
  if (!cfg) throw new CooktraceError('Link CookTrace in Settings first.', 409);
  const added = [];
  for (const name of names) {
    let result;
    try {
      result = await _mcp(cfg.url, cfg.token, 'tools/call', { name: 'add_shopping_item', arguments: { name } });
    } catch (e) {
      if (!added.length) throw e;
      return { added: added.length, failed: names.length - added.length, error: e.message };
    }
    if (result?.isError) {
      const text = result.content?.map(c => c.text || '').join(' ').trim();
      const error = /not found|unknown tool/i.test(text || '') ? 'This CookTrace doesn\'t allow adding items. Set MCP_WRITE_ENABLED=1 there.' : (text || 'CookTrace refused an item.');
      if (!added.length) throw new CooktraceError(error, 400);
      return { added: added.length, failed: names.length - added.length, error };
    }
    added.push(name);
  }
  return { added: added.length, failed: 0 };
}
