/**
 * A sign-in cookie left on the phone never decides whose data the server
 * answers with.
 *
 * Signing in on the phone through CapacitorHttp (first-run setup, Settings >
 * Server > Connect) leaves the server's note_token cookie in Android's
 * native cookie jar, and every later native request sends it, next to the
 * Authorization header of whoever is signed in now. The server read the
 * cookie first, so after one account signed out and another signed in,
 * the second account's native requests were answered, and written, as the
 * first. The app's own modules run here as the phone
 * (scripts/fixtures/native-cookies) against a real server
 * (server/index.js on a scratch database).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = new URL('./fixtures/native-cookies/', import.meta.url);
const SRC = new URL('../src/', import.meta.url).href;
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
let ready = false;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  await import('svelte/store');
  ready = true;
} catch { /* better-sqlite3 or the app's packages missing: the server cases skip */ }

const dir = ready ? mkdtempSync(join(tmpdir(), 'note-cookies-')) : null;
let server = null, base = null, sqlite = null;
const PW = 'Str0ng-Pass-77!x';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const skip = t => { if (!ready) { t.skip('better-sqlite3 or the app packages are missing'); return true; } return false; };

// One phone run: `code` ends with done(result). Same `jar` = same phone.
function phone(jar, code) {
  const prelude = `const SRC = ${JSON.stringify(SRC)}; const S = process.env.NOTE_SERVER; const PW = ${JSON.stringify(PW)};
const done = x => { console.log('RESULT ' + JSON.stringify(x ?? null)); process.exit(0); };\n`;
  const r = spawnSync(process.execPath, ['--import', new URL('register.mjs', fixtures).href, '--input-type=module', '-e', prelude + code], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, NOTE_SERVER: base, PHONE_JAR: join(dir, jar + '.cookies.json') },
  });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  if (!line) throw new Error(`phone ${jar} failed:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(7));
}

test.before(async () => {
  if (!ready) return;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['index.js'], {
    cwd: join(root, 'server'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'server.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: 'native-cookies-test-secret-0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test' },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {}
    await sleep(250);
  }
  const reg = (name, tok) => fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify({ username: name, password: PW }) });
  assert.ok((await reg('alice')).ok, 'first account');
  const admin = await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: PW }) })).json();
  assert.ok((await reg('bob', admin.token)).ok, 'second account');
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  sqlite = new Database(join(dir, 'server.db'), { readonly: true, fileMustExist: true });
});
test.after(() => {
  try { sqlite?.close(); } catch {}
  try { server?.kill(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Alice signs in on the phone (as first-run setup does: CapacitorHttp), a
// sign-in gate in front of the server has its own cookies, Alice signs out
// (stores/auth.js logout), and Bob signs in on the Login page (the
// WebView's fetch, as Login.svelte does). Then Bob's native requests:
// Settings > Server's upload of the phone's settings (lib/migrate.js) and
// a CapacitorHttp call with his token. Where the app forgets the server's
// cookies, the run does it at the same steps the screens do.
const SWITCH = `
const { CapacitorHttp, CapacitorCookies } = await import('@capacitor/core');
const platform = await import(SRC + 'lib/platform.js');
const auth = await import(SRC + 'stores/auth.js');
const migrate = await import(SRC + 'lib/migrate.js');
const forget = typeof platform.forgetServerCookies === 'function' ? platform.forgetServerCookies : async () => {};
platform.setNativeMode('server');
platform.setServerUrl(S);
const login = await CapacitorHttp.post({ url: S + '/api/auth/login', headers: { 'Content-Type': 'application/json' }, data: { username: 'alice', password: PW } });
const aliceJar = Object.keys(await CapacitorCookies.getCookies({ url: S })).sort();
platform.setAuthToken(login.data.token);
await forget(S);
await CapacitorCookies.setCookie({ url: S, key: 'authelia_session', value: 'gate' });
await CapacitorCookies.setCookie({ url: 'https://gate.example.com', key: 'CF_Authorization', value: 'gate' });
localStorage.setItem('wl:userId', '1');
localStorage.setItem('note:cachedUser', JSON.stringify(login.data.user));
await auth.logout();
const r = await fetch(S + '/api/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: PW }) });
const bob = await r.json();
platform.setAuthToken(bob.token);
await forget();
const jar = await CapacitorCookies._all();
localStorage.setItem('wl_u' + bob.user.id + '_cookieCheck', 'set-by-bob');
const up = await migrate.uploadLocalToServer({ serverUrl: S, authToken: bob.token });
const me = await CapacitorHttp.get({ url: S + '/api/auth/me', headers: { Authorization: 'Bearer ' + bob.token } });
done({ aliceJar, jar, who: me.data.user?.username ?? null, uploaded: up.success.settings, errors: up.errors.map(e => e.stage) });
`;

test("after another account signs in, the phone's native requests are answered as that account", async (t) => {
  if (skip(t)) return;
  const r = phone('switch', SWITCH);
  assert.deepEqual(r.aliceJar, ['note_token'], "the phone's sign-in leaves the server's cookie in the native jar");
  const owners = sqlite.prepare(`SELECT u.username FROM user_settings s JOIN users u ON u.id = s.user_id WHERE s.key = 'cookieCheck'`).all().map(x => x.username);
  assert.deepEqual({ who: r.who, uploaded: r.uploaded, owners }, { who: 'bob', uploaded: 1, owners: ['bob'] },
    "Bob's native requests are answered as Bob, and his settings go to his account");
});

test("signing out and in forgets only NoteTrace's cookies, at the server and the app's own address", async (t) => {
  if (skip(t)) return;
  const r = phone('jar', SWITCH);
  const host = new URL(base).hostname;
  assert.deepEqual(r.jar, { [host]: { authelia_session: 'gate' }, 'app.notetrace.local': {}, 'gate.example.com': { CF_Authorization: 'gate' } },
    "no note_token anywhere; a sign-in gate's cookies stay");
});

// The phone forgets the cookies at every address it knows: the one being
// connected to, the one in use and the last one used, and its own.
test('the cookies go at the new, current and previous server', async (t) => {
  if (skip(t)) return;
  const r = phone('addresses', `
    const { CapacitorCookies } = await import('@capacitor/core');
    const platform = await import(SRC + 'lib/platform.js');
    const at = ['https://old.example.com', 'https://now.example.com', 'https://new.example.com', 'https://app.notetrace.local', 'https://other.example.com'];
    const fill = async () => { for (const url of at) for (const key of ['note_token', 'note_oidc_logout', 'keep']) await CapacitorCookies.setCookie({ url, key, value: 'x' }); };
    await fill();
    // Disconnected from the old server, connecting to a new one.
    platform.setServerUrl('https://old.example.com');
    platform.setServerUrl(null);
    await platform.forgetServerCookies('https://new.example.com:8443/');
    const connecting = await CapacitorCookies._all();
    await fill();
    // Signed in to a server at a sub-path.
    platform.setServerUrl('https://now.example.com/notes');
    await platform.forgetServerCookies();
    done({ connecting, signedIn: await CapacitorCookies._all() });`);
  const kept = { keep: 'x' }, all = { note_token: 'x', note_oidc_logout: 'x', keep: 'x' };
  assert.deepEqual(r.connecting, { 'old.example.com': kept, 'now.example.com': all, 'new.example.com': kept, 'app.notetrace.local': kept, 'other.example.com': all });
  assert.deepEqual(r.signedIn, { 'old.example.com': all, 'now.example.com': kept, 'new.example.com': all, 'app.notetrace.local': kept, 'other.example.com': all });
});

test("forgetting the cookies is a no-op on the web and never throws", async () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const platform = await import(${JSON.stringify(SRC + 'lib/platform.js')});
    const { CapacitorCookies } = await import('@capacitor/core');
    let calls = 0;
    CapacitorCookies.deleteCookie = async () => { calls++; };
    await platform.forgetServerCookies('https://example.com');
    console.log('RESULT ' + JSON.stringify({ native: platform.isNative, calls }));`], { cwd: root, encoding: 'utf8' });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, r.stderr);
  assert.deepEqual(JSON.parse(line.slice(7)), { native: false, calls: 0 });
  const thrown = phone('throws', `
    const { CapacitorCookies } = await import('@capacitor/core');
    CapacitorCookies.deleteCookie = async () => { throw new Error('bridge gone'); };
    const platform = await import(SRC + 'lib/platform.js');
    platform.setServerUrl('not a url');
    await platform.forgetServerCookies(undefined, null, '');
    done('ok');`);
  assert.equal(thrown, 'ok');
});

// Every way an account changes on the phone forgets the cookies.
test('sign-in, Connect, Disconnect, sign-out and a lost session all forget the cookies', () => {
  const calls = (file) => (read(file).match(/forgetServerCookies\(/g) || []).length;
  assert.ok(calls('../src/routes/Login.svelte') >= 2, 'password and biometric sign-in');
  assert.ok(calls('../src/routes/NativeSetup.svelte') >= 2, 'first-run password and SSO sign-in');
  assert.ok(calls('../src/App.svelte') >= 1, 'SSO sign-in coming back to the app');
  assert.ok(calls('../src/components/settings/SettingsServerConnection.svelte') >= 3, 'Connect, cancel and Disconnect');
  assert.ok(calls('../src/components/settings/SettingsUserManagement.svelte') >= 1, 'turning user management off signs out');
  assert.ok(calls('../src/stores/auth.js') >= 2, 'sign-out and a session the server no longer knows');
  assert.ok(calls('../src/lib/sync.js') >= 1, 'a sync answered 401');
});
