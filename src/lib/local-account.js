/**
 * local-account.js: whose data the phone's local database holds.
 *
 * Native server mode keeps a full copy of the account in SQLite, and one
 * phone can sign in to more than one account (or server). The copy is
 * tagged with the account it belongs to (sync_meta 'account', JSON: the
 * server's instance id "i", its address "s", the user id "u", and when
 * the account was made "c"; or { local: true } for the phone's own data),
 * so that:
 *   - signing in as someone else never shows the previous account's notes,
 *     labels or settings: the copy is cleared and filled from the new
 *     account on the next sync, from the start;
 *   - the previous account's changes that never reached the server are
 *     never pushed under the new one. If there are any, the person signing
 *     in is asked first; saying no undoes the sign-in, and the changes go
 *     up the next time that account signs in here;
 *   - signing out and back in to the same account keeps everything,
 *     including changes still waiting.
 *
 * Same account means the same user id, made at the same time, on the same
 * server. The same user id at the same address is the same account unless
 * it was made at another time (a server rebuilt with a fresh database). At
 * another address, the server is known by the random id it reports
 * (/api/auth/status instance_id), so the same server at a LAN IP and at
 * its domain is one server, and two different ids are two servers. When
 * either id is unknown (a server too old to report one, or one that can't
 * be reached), it can't be decided here: the person is asked whether it's
 * the same server, and saying no treats the copy as another account's.
 *
 * Copies made before this tag existed, and copies in local mode (no
 * server, or after Disconnect), go to the first account that signs in, as
 * they always did. Connecting to a server from Settings decides for itself
 * (claimForServer), since the person chose there what happens to the data.
 */
import { writable, get } from 'svelte/store';
import { getServerUrl, getAuthToken, forgetServerCookies } from './platform.js';
import { dbGetMeta, dbSetMeta, dbCountUnsynced, dbClearUserData, dbKeepForNewServer, dbResetPullCursor, dbDropSharedIn } from './db-native.js';
import { resetUserState } from './user-state.js';

const META_KEY = 'account';

// Moves on every change of account (another one signing in, connecting to
// a server, going local, signing out). A sync started before it writes
// nothing after it (sync.js checks before every write).
let _generation = 0;
export const accountGeneration = () => _generation;
export function bumpAccountGeneration() { _generation++; }

function _server(url = getServerUrl()) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

// The user id inside the session token (the server signs { id, ... }).
export function tokenUserId(token = getAuthToken()) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return json?.id ?? null;
  } catch {
    return null;
  }
}

// What the server reports about itself (/api/auth/status): its instance
// id. Asked once per address per app run, and kept (sync_meta) for when it
// can't be reached.
const _instances = new Map(); // address -> instance id
async function _askServer(serverUrl, url) {
  try {
    const res = await fetch(`${String(serverUrl).trim().replace(/\/+$/, '')}/api/auth/status`, {
      credentials: 'include', signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const i = typeof body?.instance_id === 'string' && body.instance_id ? body.instance_id : null;
      if (i) await dbSetMeta(`instance@${url}`, i);
      _instances.set(url, i);
      return { i };
    }
  } catch { /* not reached */ }
  return null;
}
export async function serverInstanceId(serverUrl = getServerUrl(), { tries = 1 } = {}) {
  const url = _server(serverUrl);
  if (!url) return null;
  if (_instances.has(url)) return _instances.get(url);
  for (let n = 0; n < tries; n++) {
    if (n) await new Promise(r => setTimeout(r, 1000));
    const got = await _askServer(serverUrl, url);
    if (got) return got.i;
  }
  return (await dbGetMeta(`instance@${url}`)) || null;
}

// The instance id last seen at this address, without asking the server.
async function _knownInstance(serverUrl = getServerUrl()) {
  const url = _server(serverUrl);
  if (!url) return null;
  if (_instances.has(url)) return _instances.get(url);
  return (await dbGetMeta(`instance@${url}`)) || null;
}

async function _readOwner() {
  const raw = await dbGetMeta(META_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const _unowned = owner => !owner || owner.local || owner.u == null;
async function _setOwner(tag) {
  await dbSetMeta(META_KEY, JSON.stringify(tag));
}
// The same account at a new address of its server: its settings, kept
// per server (lib/setting-key.js), come along.
async function _retag(owner, tag) {
  if (owner && !_unowned(owner) && owner.s && tag.s && owner.s !== tag.s) {
    try { (await import('./setting-key.js')).moveSettingScope(tag.u, owner.s); } catch {}
  }
  await _setOwner(tag);
}

/**
 * Whether a copy tagged `owner` is user `userId`'s on this server:
 * { same, tag }, `tag` being the tag to write when it should change
 * (claimed, or the same server at a new address). Only asks the server
 * for its id when the address differs.
 */
export async function matchOwner(owner, userId, serverUrl = getServerUrl(), created = null, { tries = 1 } = {}) {
  const s = _server(serverUrl);
  const c = created || null;
  if (_unowned(owner)) return { same: true, tag: { i: await _knownInstance(serverUrl), s, u: userId, c } };
  if (String(owner.u) !== String(userId)) return { same: false };
  // The same id on a server rebuilt with a fresh database is someone
  // else: the account was made at another time (a restore keeps it).
  if (owner.c && c && owner.c !== c) return { same: false };
  const fill = !owner.c && c;
  if (owner.s === s) return { same: true, ...(fill ? { tag: { ...owner, c } } : {}) };
  // Another address: only the servers' own ids can tell. User ids repeat
  // across servers (the first admin is 1 on every one), so without both
  // ids it can't be decided here: the person is asked (`ambiguous`).
  const i = await serverInstanceId(serverUrl, { tries });
  const tag = { i: i || owner.i || null, s, u: userId, c: owner.c || c };
  if (!owner.i || !i) return { same: false, ambiguous: true, tag };
  if (owner.i !== i) return { same: false };
  return { same: true, tag };
}

/**
 * Sync gate: false only when the local data is known to be another
 * account's than the one whose token the request carries (`token`, the
 * one a push or pull started with). A copy with no owner yet is claimed
 * for it. A token with no user id in it (single-user servers) doesn't
 * block. Online, it also fills in the server's id on the tag.
 */
export async function localDataIsThisAccount(token = getAuthToken()) {
  if (_restoring) return false;
  const id = tokenUserId(token);
  if (id == null) return true;
  const owner = await _readOwner();
  // The phone's own copy (local mode, Disconnect) is handed to an account
  // only by the account check or by Connect (claimForServer), never by a
  // sync that happens to run meanwhile: that would lose which account it
  // came from (`was`).
  if (owner?.local) return false;
  // When the account was made, as the server last said (stores/auth.js
  // keeps it): the same id on a server rebuilt with a fresh database is
  // someone else, and nothing goes up or comes down for them here until
  // the account check has run.
  let created = null;
  try {
    const cached = JSON.parse(localStorage.getItem('note:cachedUser') || 'null');
    if (cached && String(cached.id) === String(id)) created = cached.created_at || null;
  } catch { /* none */ }
  const m = await matchOwner(owner, id, getServerUrl(), created);
  if (!m.same) return false;
  if (m.tag) await _retag(owner, { ...m.tag, c: m.tag.c ?? owner?.c ?? null });
  else if (!owner.i) {
    const i = await serverInstanceId();
    if (i) await _setOwner({ ...owner, i });
  }
  return true;
}

/** Local mode (Disconnect, or chose local at setup): the data is this
 *  phone's own now, and goes to whichever account it's connected to next.
 *  Which account it came from is kept (`was`), so connecting to that same
 *  account again sends up only what's new (cameFromThisAccount). */
export async function setLocalOwner() {
  resetAccountGate();
  await _syncIdle();
  await _clearReminders();
  await forgetServerCookies();
  const owner = await _readOwner();
  const was = _unowned(owner) ? (owner?.was || null) : { i: owner.i || null, s: owner.s, u: owner.u, c: owner.c || null };
  await dbSetMeta(META_KEY, JSON.stringify({ local: true, ...(was ? { was } : {}) }));
}

/**
 * Connecting from Settings: whether the phone's data came from this very
 * account on this server (it was disconnected from it). Its rows then keep
 * their ids there, and only what was made or changed since goes up, once.
 * At another address only the servers' ids can tell; without them the
 * person is asked, and no answer counts as not the same.
 */
export async function cameFromThisAccount(serverUrl, user, { sameServer = _askSameServer } = {}) {
  if (!user || user.id == null) return false;
  const owner = await _readOwner();
  const was = owner?.local ? owner.was : null;
  if (!was) return false;
  const m = await matchOwner(was, user.id, serverUrl, user.created_at || null);
  if (m.same) return true;
  // null: the question was closed without an answer (the caller stops).
  if (m.ambiguous) { const a = await sameServer(); return a == null ? null : a === true; }
  return false;
}

/** A local backup restored: where the phone's data came from is unknown. */
export async function forgetCopyOrigin() {
  const owner = await _readOwner();
  if (owner?.local && owner.was) await dbSetMeta(META_KEY, JSON.stringify({ local: true }));
}

/** Whose copy this is (a backup carries it, lib/local-backup.js). */
export async function copyTag() {
  return _readOwner();
}

/** A local backup is about to replace the copy: nothing still running
 *  writes into it, and no sync starts, until afterRestore (or endRestore,
 *  if the restore fails). */
let _restoring = false;
export async function beforeRestore() {
  _restoring = true;
  await _syncIdle();
}
export function endRestore() { _restoring = false; }

/**
 * A local backup was restored into the copy. Connected to a server:
 *   - made from this same account on this same server (its tag): its rows
 *     keep their ids, and the next pull goes from the start; rows the
 *     server no longer has go up again once (lib/sync.js);
 *   - from another account, another server, local mode, or with no tag:
 *     none of its ids mean anything here. Its rows go up as this
 *     account's, new, once (their create keys), and notes shared with
 *     that other account stay out. Nothing is ever written into another
 *     account's rows.
 * In local mode, where the data came from is no longer known.
 */
export async function afterRestore(backupTag) {
  try {
    const cur = await _readOwner();
    if (!getServerUrl() || cur?.local) { await forgetCopyOrigin(); return 'local'; }
    // A backup taken in local mode after a Disconnect carries the account
    // its data came from (`was`).
    const raw = backupTag && typeof backupTag === 'object' ? backupTag : null;
    const t = raw?.local ? (raw.was || null) : raw;
    const same = !!(t && t.u != null && cur && !_unowned(cur) && String(t.u) === String(cur.u)
      && (t.s === cur.s || (t.i && cur.i && t.i === cur.i))
      && !(t.i && cur.i && t.i !== cur.i)
      && (!t.c || !cur.c || t.c === cur.c));
    if (same) {
      await dbResetPullCursor();
      await dbSetMeta('reconcile_missing', '1');
      return 'same';
    }
    await dbDropSharedIn();
    await dbKeepForNewServer();
    return 'other';
  } finally {
    _restoring = false;
  }
}

/**
 * Connecting to a server from Settings, after the person chose what
 * happens to the phone's data there (lib/migrate.js). `clear` (Download):
 * the copy is emptied and fills from that account. `sameAccount`: the data
 * came from this account (cameFromThisAccount), so only what's new goes
 * up. Otherwise (Upload, Merge, or nothing on the phone) every row goes up
 * to it as new: ids from a server it may have synced with before mean
 * nothing there. Either way
 * the copy is that account's now and fills from it from the start, so
 * signing in afterwards neither asks nor clears.
 */
export async function claimForServer(serverUrl, userId, { created = null, clear = false, sameAccount = false } = {}) {
  resetAccountGate();
  await _syncIdle();
  await forgetServerCookies(serverUrl);
  await resetUserState();
  if (clear) await dbClearUserData();
  // Back to the account the data came from: its rows keep their ids, and
  // the pull starts over to bring what changed there meanwhile.
  else if (sameAccount) await dbResetPullCursor();
  else await dbKeepForNewServer();
  await _setOwner({ i: await serverInstanceId(serverUrl), s: _server(serverUrl), u: userId, c: created });
}

// A sync still running carries the session it started with and writes
// into the copy until it ends. The account generation moves first, so it
// writes nothing more; its requests are aborted, and the copy changes
// hands only once it has actually stopped.
async function _syncIdle() {
  _generation++;
  try {
    const { stopSync } = await import('./sync.js');
    await stopSync();
  } catch { /* nothing running */ }
}

async function _askSameServer() {
  const { confirmDialog } = await import('../stores/confirmDialog.js');
  const { _ } = await import('svelte-i18n');
  const say = get(_);
  return confirmDialog({
    title: say('sync.same_server_title'),
    message: say('sync.same_server'),
    confirmText: say('sync.same_server_yes'),
    cancelText: say('sync.same_server_no'),
    // Closed without an answer: nothing is decided (prepareLocalAccount).
    dismissed: null,
  });
}

async function _askToDiscard(count) {
  const { confirmDialog } = await import('../stores/confirmDialog.js');
  const { _ } = await import('svelte-i18n');
  const say = get(_);
  return confirmDialog({
    title: say('sync.switch_account_waiting_title'),
    message: say('sync.switch_account_waiting', { values: { count } }),
    confirmText: say('sync.switch_account_anyway'),
    dangerous: true,
  });
}

async function _clearReminders() {
  try { await (await import('./note-reminders.js')).clearReminders(); } catch { /* none set */ }
}

// What the phone shows of the copy outside the app (reminders it set, the
// home screen widget) and in the app's lists: emptied with it.
async function _afterClear() {
  await Promise.allSettled([
    import('./note-reminders.js').then(m => m.rescheduleReminders?.()),
    import('./home-widget.js').then(m => m.clearHomeWidget?.()),
  ]);
}

/**
 * Make the copy this account's. Returns false when the person chose to
 * keep the previous account's unsent changes: the caller then undoes the
 * sign-in. `confirm(count)` and `sameServer()` replace the dialogs (tests).
 */
export async function prepareLocalAccount(user, { confirm = _askToDiscard, sameServer = _askSameServer } = {}) {
  if (!user || user.id == null) return true;
  const owner = await _readOwner();
  // A server that didn't answer is asked again before anyone is asked.
  const m = await matchOwner(owner, user.id, getServerUrl(), user.created_at || null, { tries: 3 });
  // Not answered (the question closed without a choice): nothing is
  // cleared and nothing goes up; the sign-in is undone and the question
  // comes back next time.
  const answer = m.ambiguous ? await sameServer() : null;
  if (m.ambiguous && answer == null) return false;
  if (m.same || answer === true) {
    if (m.tag) await _retag(owner, m.tag);
    return true;
  }
  await _syncIdle();
  // The previous account's reminders stop now, whatever is answered below:
  // they come back from that account's own copy when it's current again.
  await _clearReminders();
  // Notes, lists, labels and the rest. Settings aren't asked about: the
  // previous account keeps its own on this phone (lib/setting-key.js), and
  // one the app set by itself (the time zone) would ask about nothing.
  const waiting = await dbCountUnsynced({ settings: false });
  if (waiting > 0 && !(await confirm(waiting))) return false;
  await forgetServerCookies(owner?.s);
  await resetUserState();
  await dbClearUserData();
  await _setOwner({ i: await _knownInstance(), s: _server(), u: user.id, c: user.created_at || null });
  await _afterClear();
  return true;
}

// ── The gate App.svelte shows the app behind ─────────────────────────────
// One check at a time, and one per account: asking again for the account
// being checked (Svelte re-running its reactive block, a refreshed user
// object) gets the same answer, never a second dialog. A check that ends
// in signing out stays the running one until the sign-out has finished.
// state: 'idle' | 'checking' | 'ready' | 'signing_out' | 'error'
export const accountGate = writable({ state: 'idle', key: null, error: null });
let _running = null; // { key, promise }
// The account: its server, its id, and when it was made (the same id on a
// server rebuilt with a fresh database is someone else, so a refreshed
// user with another created_at is checked again).
const _gateKey = user => `${_server()}#${user.id}#${user.created_at || ''}`;

export function resetAccountGate() {
  if (!_running) accountGate.set({ state: 'idle', key: null, error: null });
}

export function ensureLocalAccount(user, { confirm, signOut, sameServer } = {}) {
  if (!user || user.id == null) return Promise.resolve(true);
  const key = _gateKey(user);
  const now = get(accountGate);
  if (now.state === 'ready' && now.key === key && !_running) return Promise.resolve(true);
  if (_running?.key === key) return _running.promise;
  const before = _running?.promise || Promise.resolve();
  const promise = before.catch(() => {}).then(() => _check(user, key, { confirm, signOut, sameServer }));
  const run = { key, promise };
  _running = run;
  promise.finally(() => { if (_running === run) _running = null; });
  return promise;
}

async function _check(user, key, { confirm, signOut, sameServer }) {
  accountGate.set({ state: 'checking', key, error: null });
  let ok;
  try {
    ok = await prepareLocalAccount(user, { ...(confirm ? { confirm } : {}), ...(sameServer ? { sameServer } : {}) });
  } catch (e) {
    // Not knowing whose data this is: show nothing of it, say so, and
    // offer to try again or sign out.
    accountGate.set({ state: 'error', key, error: e?.message || String(e) });
    return false;
  }
  if (!ok) {
    accountGate.set({ state: 'signing_out', key, error: null });
    try { await signOut?.(); } catch { /* the sign-in is undone either way */ }
    accountGate.set({ state: 'idle', key: null, error: null });
    return false;
  }
  accountGate.set({ state: 'ready', key, error: null });
  return true;
}

// Whether the phone's copy is the signed-in account's yet. Until the gate
// has checked, it may still hold the previous account's data, including
// settings it never sent: the new account's settings wait to be written
// into it (stores/settings.js), so they're neither counted as the previous
// account's nor written over its unsent ones. Local mode has one owner.
export function localCopyIsCurrent(userId = localStorage.getItem('wl:userId')) {
  if (!getServerUrl()) return true;
  // A server without accounts (single-user): one copy, no one to check.
  if (tokenUserId() == null) {
    try { if (localStorage.getItem('note:cachedUserMgmt') === '0') return true; } catch { /* storage unavailable */ }
  }
  if (userId == null || userId === '') return false;
  return accountReadyFor(get(accountGate), userId);
}
/** Whether the copy is already tagged as this account's, on this server
 *  (its rows waiting to go up are this account's own), before the check
 *  has run. */
export async function copyTaggedFor(userId = localStorage.getItem('wl:userId')) {
  if (!getServerUrl()) return true;
  const owner = await _readOwner();
  return !_unowned(owner) && userId != null && String(owner.u) === String(userId) && owner.s === _server();
}
/** Resolves true once the copy is this account's, false if that takes longer than `ms`. */
export function whenLocalCopyIsCurrent(userId = localStorage.getItem('wl:userId'), ms = 60_000) {
  if (localCopyIsCurrent(userId)) return Promise.resolve(true);
  return new Promise(resolve => {
    let unsub = null, done = false;
    const end = ok => { if (done) return; done = true; clearTimeout(timer); queueMicrotask(() => unsub?.()); resolve(ok); };
    const timer = setTimeout(() => end(false), ms);
    // Also what the check doesn't drive: a server found to have no
    // accounts (single-user), or a sign-in.
    const poll = setInterval(() => { if (done) clearInterval(poll); else if (localCopyIsCurrent(userId)) { clearInterval(poll); end(true); } }, 1000);
    unsub = accountGate.subscribe(g => { if (userId != null && accountReadyFor(g, userId)) end(true); });
  });
}

/**
 * Whether what the phone shows outside the app (the home screen widget,
 * reminder alarms) may come from its copy now: in local mode always; in
 * server mode only while signed in and once the copy is the signed-in
 * account's. A server without accounts (single-user) has none to check.
 */
export function copyMayShowOutside() {
  if (!getServerUrl()) return true;
  const id = tokenUserId();
  if (id == null) {
    try { return !!getAuthToken() || localStorage.getItem('note:cachedUserMgmt') === '0'; } catch { return false; }
  }
  return localCopyIsCurrent(id);
}

/** Whether the app may show the data for this user now (`who`: the user,
 *  or just their id). */
export function accountReadyFor(gate, who) {
  if (gate?.state !== 'ready' || !gate.key) return false;
  if (who && typeof who === 'object') return gate.key === _gateKey(who);
  return who != null && gate.key.startsWith(`${_server()}#${who}#`);
}
