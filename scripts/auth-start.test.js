/**
 * The app never opens with nobody signed in on a server that has accounts.
 *
 * The web app asks the server who is signed in (stores/auth.js). When it
 * couldn't (the server restarting behind a proxy's 502 page, a sign-in
 * proxy's page, a dropped connection), it used to take the server for one
 * without accounts and open the app empty: "No Notes Yet" and "Not
 * authenticated", as if every note were gone. Now the sign-in page opens,
 * saying why with Retry (routes/Login.svelte), unless the server was last
 * seen without accounts or this browser has the signed-in account cached.
 * A browser that never learned what the server is and simply has no
 * connection opens the app as it always did (single-user browsers from
 * before the server's kind was kept). The Android app after Log Out goes
 * to sign-in, reachable or not.
 *
 * stores/auth.js runs here in Node (scripts/fixtures/auth-start) with
 * fetch answered per case.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const SRC = new URL('../src/', import.meta.url).href;
const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
let ready = true;
try { await import('svelte/store'); } catch { ready = false; }
const skip = (t) => { if (!ready) { t.skip('the app packages are missing'); return true; } return false; };

/** Starts the app's auth once: { mgmt, user, unavailable, store }. */
function start({ phone = false, store = {}, replies = {}, wait = 0 } = {}) {
  const code = `
const auth = await import(${JSON.stringify(SRC + 'stores/auth.js')});
const { get } = await import('svelte/store');
await auth.loadAuthState();
await new Promise(r => setTimeout(r, ${wait}));
const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
console.log('RESULT ' + JSON.stringify({ mgmt: get(auth.userMgmtActive), user: get(auth.currentUser), unavailable: auth.authUnavailable ? get(auth.authUnavailable) : null, store: ls }));
process.exit(0);`;
  const r = spawnSync(process.execPath, ['--import', new URL('./fixtures/auth-start/register.mjs', import.meta.url).href, '--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, AUTH_PHONE: phone ? '1' : '', AUTH_STORE: JSON.stringify(store), AUTH_REPLIES: JSON.stringify(replies) },
  });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  if (!line) throw new Error(`auth start failed:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(7));
}

const json = (body, status = 200) => ({ status, body, type: 'application/json' });
const page = (status = 200) => ({ status, body: '<!doctype html><title>Sign in</title><h1>Sign in</h1>', type: 'text/html' });
const ACCOUNTS = { active: true, setup_required: false, single_user_mode: false, oidc: { providers: [] } };
const SINGLE = { active: false, setup_required: false, single_user_mode: true, oidc: { providers: [] } };
const SIGNED_OUT = json({ user: null, csrf: null });
const ANN = { id: 7, username: 'ann', role: 'admin' };
// The app's sign-in page or the server-unreachable screen: never the app.
const blocked = (s) => s.mgmt === true && s.user == null;

test('the web app, server not answering: the sign-in page saying why, never the app with nobody signed in', (t) => {
  if (skip(t)) return;
  const cases = {
    'a gateway 502 page': [{ '/api/auth/status': page(502), '/api/auth/me': page(502) }, 'unreachable'],
    'a sign-in proxy page': [{ '/api/auth/status': page(200), '/api/auth/me': page(200) }, 'proxy_sign_in'],
    'a sign-in proxy redirect, not followed': [{ '/api/auth/status': 'redirect', '/api/auth/me': 'redirect' }, 'proxy_sign_in'],
    'an empty 200': [{ '/api/auth/status': { status: 200, body: '' }, '/api/auth/me': { status: 200, body: '' } }, 'proxy_sign_in'],
    'the server starting (503 with JSON)': [{ '/api/auth/status': json({ error: 'starting' }, 503), '/api/auth/me': json({ error: 'starting' }, 503) }, 'server_error'],
    'too many requests (429 with JSON)': [{ '/api/auth/status': json({ error: 'slow down' }, 429), '/api/auth/me': json({ error: 'slow down' }, 429) }, 'server_error'],
    'a gateway 504 page': [{ '/api/auth/status': page(504), '/api/auth/me': page(504) }, 'unreachable'],
    'only /me failing': [{ '/api/auth/status': json(ACCOUNTS), '/api/auth/me': page(502) }, 'unreachable'],
  };
  for (const [name, [replies, why]] of Object.entries(cases)) {
    const s = start({ replies });
    assert.ok(blocked(s), `${name}: ${JSON.stringify(s)}`);
    assert.equal(s.unavailable, why, name);
    assert.ok(en.server_signin[why], `${name}: said in words`);
  }
  // A server with accounts, signed out here before: no connection is the sign-in page too.
  const seen = start({ store: { 'note:cachedUserMgmt': '1' } });
  assert.deepEqual([blocked(seen), seen.unavailable], [true, 'unreachable']);
});

test('upgrading: a browser that never learned what the server is, simply offline, opens as before', (t) => {
  if (skip(t)) return;
  // Single-user browsers from before kept nothing, and the new code's first run can be offline.
  const s = start({});
  assert.deepEqual([s.mgmt, s.user, s.unavailable], [false, null, null], 'the app, as it always opened');
  assert.equal(s.store['note:cachedUserMgmt'], undefined, 'nothing remembered from it');
  // Anything that isn't plain "no connection" still gets the sign-in page.
  assert.equal(start({ replies: { '/api/auth/status': page(200), '/api/auth/me': page(200) } }).unavailable, 'proxy_sign_in');
  assert.equal(start({ replies: { '/api/auth/status': page(502), '/api/auth/me': page(502) } }).unavailable, 'unreachable');
});

test('the web app still opens when it should: a cached account, or a server last seen without accounts', (t) => {
  if (skip(t)) return;
  const signedIn = start({ store: { 'note:cachedUser': JSON.stringify(ANN), 'note:cachedUserMgmt': '1' } });
  assert.deepEqual([signedIn.user?.id, signedIn.mgmt, signedIn.unavailable], [7, true, null], 'offline with the account cached: the app');
  const single = start({ store: { 'note:cachedUserMgmt': '0' } });
  assert.deepEqual([single.mgmt, single.user?.username, single.unavailable], [false, 'local', null], 'a single-user server offline: the app, as online');
});

test('the web app remembers what the server is, signed in or not', (t) => {
  if (skip(t)) return;
  const out = start({ replies: { '/api/auth/status': json(ACCOUNTS), '/api/auth/me': SIGNED_OUT } });
  assert.deepEqual([out.mgmt, out.user, out.unavailable, out.store['note:cachedUserMgmt']], [true, null, null, '1'], 'signed out: the sign-in page, and it is a server with accounts');
  const single = start({ replies: { '/api/auth/status': json(SINGLE), '/api/auth/me': SIGNED_OUT } });
  assert.deepEqual([single.mgmt, single.user?.username, single.store['note:cachedUserMgmt']], [false, 'local', '0']);
  const fresh = start({ store: { 'note:cachedUserMgmt': '0' }, replies: { '/api/auth/status': json({ active: false, setup_required: true }), '/api/auth/me': SIGNED_OUT } });
  assert.equal(fresh.store['note:cachedUserMgmt'], undefined, 'a fresh install is neither');
  // Answered again: the screen goes.
  const back = start({ replies: { '/api/auth/status': json(ACCOUNTS), '/api/auth/me': SIGNED_OUT } });
  assert.equal(back.unavailable, null);
});

test('Android after Log Out: the sign-in page, whether the server answers or not', (t) => {
  if (skip(t)) return;
  // What logout() leaves: the server, no token, no cached account; the server's kind stays.
  const after = { 'note:nativeMode': 'server', 'note:serverUrl': 'https://notes.example.com', 'note:cachedUserMgmt': '1' };
  for (const [name, replies] of Object.entries({
    reachable: { '/api/auth/status': json(ACCOUNTS), '/api/auth/me': json({ error: 'Not authenticated' }, 401) },
    unreachable: {},
    'behind a sign-in proxy': { '*': page(200) },
  })) {
    const s = start({ phone: true, store: after, replies, wait: 300 });
    assert.ok(blocked(s), `${name}: ${JSON.stringify(s)}`);
    assert.equal(s.unavailable, null, `${name}: the phone's own sign-in page says what's wrong`);
  }
  // Even if the server's kind was never written on this phone.
  const unknown = { ...after }; delete unknown['note:cachedUserMgmt'];
  assert.ok(blocked(start({ phone: true, store: unknown, replies: {}, wait: 300 })));
  // A phone on a server without accounts still opens.
  assert.equal(start({ phone: true, store: { ...after, 'note:cachedUserMgmt': '0' }, replies: {}, wait: 300 }).mgmt, false);
});
