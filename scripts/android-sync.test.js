/**
 * Android sync, end to end: the app's own code (db-native.js, sync.js,
 * notes-native.js, stores/auth.js, local-account.js) running as a phone in
 * Node (scripts/fixtures/android-sync) against real servers (server/index.js
 * on scratch databases). Each case was a way a phone mixed up or doubled
 * data:
 *   - signing in to another account showed the previous account's notes,
 *     sent its unsynced changes into the new account, and never downloaded
 *     the new account's own older notes (the pull went on from the previous
 *     account's cursor);
 *   - two syncs at once (the app starts several) stored every note twice
 *     and sent a note made offline twice;
 *   - a create whose answer was lost was made a second time.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = new URL('./fixtures/android-sync/', import.meta.url);
const PW = 'Str0ng-Pass-77!x';
let ready = false;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  await import('svelte/store');
  ready = true;
} catch { /* better-sqlite3 or the app's packages missing: the cases skip */ }
const skip = t => { if (!ready) { t.skip('better-sqlite3 or the app packages are missing'); return true; } return false; };

const dir = ready ? mkdtempSync(join(tmpdir(), 'note-android-')) : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

// A scratch server with alice (admin), bob and carol.
const servers = [];
async function startServer(name) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: join(root, 'server'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, `${name}.db`), UPLOADS_PATH: join(dir, `${name}-uploads`), JWT_SECRET: `android-sync-${name}-0123456789abcdef`, INSECURE_COOKIES: '1', NODE_ENV: 'test' },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {}
    await sleep(250);
  }
  const srv = { name, base, proc, tokens: {} };
  servers.push(srv);
  const reg = (u, tok) => fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify({ username: u, password: PW }) });
  // Sessions made as the server makes them (middleware/auth.js signToken):
  // signing in is rate limited.
  const jwt = createRequire(new URL('../server/package.json', import.meta.url))('jsonwebtoken');
  const secret = `android-sync-${name}-0123456789abcdef`;
  const first = await (await reg('alice')).json();
  srv.tokens.alice = jwt.sign({ id: first.user.id, username: 'alice', role: 'admin', csrf: 'test' }, secret, { expiresIn: '1h' });
  for (const u of ['bob', 'carol']) {
    const made = await (await reg(u, srv.tokens.alice)).json();
    srv.tokens[u] = jwt.sign({ id: made.user.id, username: u, role: 'user', csrf: 'test' }, secret, { expiresIn: '1h' });
  }
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  srv.q = (sql, ...a) => { const d = new Database(join(dir, `${name}.db`), { readonly: true, fileMustExist: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
  return srv;
}
async function web(srv, user, method, path, body) {
  const go = () => fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${srv.tokens[user]}` }, body: body ? JSON.stringify(body) : undefined });
  // A kept-alive connection the server closed meanwhile (its 5 s idle
  // timeout, during a long phone run) fails once with "fetch failed".
  const r = await go().catch(e => { if (e?.message === 'fetch failed') return go(); throw e; });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const note = (srv, user, title) => web(srv, user, 'POST', '/api/notes', { title, body_md: `${title} body` });
const owners = (srv, title) => srv.q(`SELECT u.username FROM notes n JOIN users u ON u.id = n.user_id WHERE n.title = ? AND n.deleted_at IS NULL`, title).map(r => r.username).sort();

// One phone run: `code` uses `p` (fixtures/android-sync/app.mjs) and ends
// with p.done(result). The same `phone` name is the same phone, across runs.
function phone(name, srv, code, env = {}) {
  const prelude = `const { open } = await import(${JSON.stringify(new URL('app.mjs', fixtures).href)}); const p = await open();\n`;
  const db = join(dir, 'phone-' + name);
  const r = spawnSync(process.execPath, ['--import', new URL('register.mjs', fixtures).href, '--input-type=module', '-e', prelude + code], {
    cwd: root, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, NOTE_SERVER: srv.base, PHONE_DB: db, PHONE_JAR: db + '.cookies.json', PHONE_TOKENS: JSON.stringify(tokens()), ...env },
  });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  if (!line) throw new Error(`phone ${name} failed:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(7));
}

let A = null, B = null;
// Every server's sessions, by address (the same server at localhost too).
const tokens = () => {
  const out = {};
  for (const s of servers) { out[s.base] = s.tokens; out[s.base.replace('127.0.0.1', 'localhost')] = s.tokens; }
  return out;
};
test.before(async () => {
  if (!ready) return;
  A = await startServer('a');
  B = await startServer('b');
  for (const u of ['alice', 'bob']) for (const n of [1, 2]) await note(A, u, `${u} note ${n}`);
  await note(B, 'alice', 'alice on server b');
});
test.after(() => {
  for (const s of servers) { try { s.proc.kill(); } catch {} }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ── Account switch ─────────────────────────────────────────────────────

test("signing in to another account shows only that account's notes, all of them", async (t) => {
  if (skip(t)) return;
  const r = phone('switch', A, `
    await p.setupSignIn('bob'); await p.sync();
    const bob = await p.shown();
    await p.logout();
    const ok = await p.loginSignIn('alice'); await p.sync();
    const alice = await p.shown();
    await p.logout();
    await p.loginSignIn('bob'); await p.sync();
    p.done({ bob, ok, alice, bobAgain: await p.shown(), asked: p.asked });`);
  assert.deepEqual(r, {
    bob: ['bob note 1', 'bob note 2'], ok: true,
    alice: ['alice note 1', 'alice note 2'],
    bobAgain: ['bob note 1', 'bob note 2'], asked: [],
  });
});

test("another account's unsynced changes: Cancel signs out and keeps them for that account; they never reach the new one", async (t) => {
  if (skip(t)) return;
  const r = phone('cancel', A, `
    await p.setupSignIn('bob'); await p.sync();
    await p.offline(async () => { await p.NotesNative.createNote({ title: 'bob offline cancel' }); await p.logout(); });
    p.answerWaiting(false);
    const ok = await p.loginSignIn('alice');
    const signedOut = !p.platform.getAuthToken();
    await p.sync();
    const left = (await p.rows()).map(n => n.title).sort();
    const again = await p.loginSignIn('bob'); await p.sync();
    p.done({ ok, signedOut, left, again, asked: p.asked, bob: await p.shown() });`);
  assert.deepEqual({ ...r, owner: owners(A, 'bob offline cancel') }, {
    ok: false, signedOut: true, asked: [{ kind: 'waiting', n: 1 }],
    left: ['bob note 1', 'bob note 2', 'bob offline cancel'],
    again: true, bob: ['bob note 1', 'bob note 2', 'bob offline cancel'],
    owner: ['bob'],
  }, "Cancel undoes the sign-in, Bob's copy and change stay, and it goes up as Bob, once");
});

test('Sign In Anyway discards the previous account\'s changes and gives a clean copy', async (t) => {
  if (skip(t)) return;
  const r = phone('anyway', A, `
    await p.setupSignIn('bob'); await p.sync();
    await p.offline(async () => { await p.NotesNative.createNote({ title: 'bob offline anyway' }); await p.dbn.dbUpsertSetting('timezone', 'Europe/Paris'); await p.logout(); });
    p.answerWaiting(true);
    const ok = await p.loginSignIn('alice'); await p.sync(); await p.sync();
    p.done({ ok, asked: p.asked, alice: await p.shown(), settings: (await p.rows('user_settings')).length });`);
  assert.deepEqual({ ok: r.ok, asked: r.asked, alice: r.alice, owner: owners(A, 'bob offline anyway') },
    { ok: true, asked: [{ kind: 'waiting', n: 1 }], alice: ['alice note 1', 'alice note 2'], owner: [] },
    'a clean copy of Alice\'s notes; Bob\'s change is discarded, never sent as anyone');
});

test("a setting still waiting isn't asked about: the previous account keeps its own on the phone", async (t) => {
  if (skip(t)) return;
  const r = phone('settingonly', A, `
    await p.setupSignIn('bob'); await p.sync();
    await p.offline(async () => { await p.dbn.dbUpsertSetting('timezone', 'Asia/Tokyo'); await p.logout(); });
    const ok = await p.loginSignIn('alice'); await p.sync();
    p.done({ ok, asked: p.asked, alice: await p.shown() });`);
  assert.deepEqual(r, { ok: true, asked: [], alice: ['alice note 1', 'alice note 2'] });
});

test('the same user id on another server is another account; the same server at another address is the same', async (t) => {
  if (skip(t)) return;
  const viaLocalhost = A.base.replace('127.0.0.1', 'localhost');
  const r = phone('servers', A, `
    await p.setupSignIn('alice'); await p.sync();
    const a = await p.shown();
    const { DB } = await import(p.SRC + 'lib/db.js');
    DB.setSetting('aiModel', 'kept on server a');
    // The same server at another address: same instance id, nothing asked.
    p.platform.setServerUrl(${JSON.stringify(viaLocalhost)});
    await p.loginSignIn('alice'); await p.sync();
    const sameAgain = await p.shown();
    const settingAtSameServer = DB.getSetting('aiModel', null);
    await p.logout();
    // Another server, where alice is user 1 as well.
    await p.setupSignIn('alice', ${JSON.stringify(B.base)}); await p.sync();
    p.done({ a, sameAgain, settingAtSameServer, b: await p.shown(), settingOnB: DB.getSetting('aiModel', null), asked: p.asked });`);
  assert.deepEqual(r, {
    a: ['alice note 1', 'alice note 2'], sameAgain: ['alice note 1', 'alice note 2'], settingAtSameServer: 'kept on server a',
    b: ['alice on server b'], settingOnB: null, asked: [],
  }, "user 1 on server b sees neither the notes nor the settings of user 1 on server a");
});

test('a server that reports no instance id at another address is asked about', async (t) => {
  if (skip(t)) return;
  const viaLocalhost = A.base.replace('127.0.0.1', 'localhost');
  const r = phone('ask', A, `
    p.net.noInstanceId = true;
    await p.setupSignIn('alice'); await p.sync();
    p.platform.setServerUrl(${JSON.stringify(viaLocalhost)});
    p.answerSameServer(false);
    await p.loginSignIn('alice'); await p.sync();
    p.done({ asked: p.asked, shown: await p.shown() });`);
  assert.deepEqual(r.asked, [{ kind: 'same_server' }]);
  assert.deepEqual(r.shown, ['alice note 1', 'alice note 2'], 'treated as another account: a clean copy, filled again');
});

test('a copy that could not be cleared shows the error, never the data', async (t) => {
  if (skip(t)) return;
  const r = phone('clearfail', A, `
    await p.setupSignIn('bob'); await p.sync();
    await p.logout();
    await p.db.execute("CREATE TRIGGER keep_notes BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT, 'locked'); END;");
    const ok = await p.loginSignIn('alice');
    p.done({ ok, gate: p.la ? p.get(p.la.accountGate).state : null });`);
  assert.deepEqual(r, { ok: false, gate: 'error' });
});

test("the home screen widget never shows another account's notes, nor any while signed out", async (t) => {
  if (skip(t)) return;
  const r = phone('widget', A, `
    const { refreshHomeWidget } = await import(p.SRC + 'lib/home-widget.js');
    const sent = async () => { globalThis.__widget = []; refreshHomeWidget({ now: true }); await p.sleep(300); return (globalThis.__widget || []).map(w => (w.notes || []).map(n => n.title).filter(x => / note \\d$/.test(x)).sort()); };
    await p.setupSignIn('bob'); await p.sync();
    const bob = await sent();
    await p.logout();
    const signedOut = await sent();
    await p.offline(async () => {});
    p.answerWaiting(true);
    const ok = await p.loginSignIn('alice'); await p.sync();
    p.done({ bob, signedOut, ok, alice: await sent() });`);
  assert.deepEqual(r.bob, [['bob note 1', 'bob note 2']]);
  assert.deepEqual(r.signedOut, [], 'nothing is sent while signed out');
  assert.deepEqual(r.alice, [['alice note 1', 'alice note 2']]);
});

test("the CookTrace link and shopping list in memory go with the account", async (t) => {
  if (skip(t)) return;
  const r = phone('cooktrace', A, `
    const ct = await import(p.SRC + 'lib/cooktrace.js');
    await p.setupSignIn('bob');
    ct.cooktraceLink.set({ connected: true, url: 'https://ct.example', username: 'bob' });
    ct.shopping.set({ items: [{ name: 'bob milk' }], at: 1, loading: false, error: null, offline: false, pending: 0 });
    await p.logout();
    p.done({ link: p.get(ct.cooktraceLink), items: p.get(ct.shopping).items });`);
  assert.deepEqual(r, { link: null, items: null });
});

test('Connect from Settings sends rows synced with another server up as new; the pull never lands on them', async (t) => {
  if (skip(t)) return;
  const r = phone('connect', A, `
    await p.setupSignIn('alice'); await p.sync();
    // Disconnect, then Connect to server b as its alice and choose Upload.
    await p.la.setLocalOwner();
    p.platform.setServerUrl(null);
    const { uploadLocalToServer } = await import(p.SRC + 'lib/migrate.js');
    const b = ${JSON.stringify(B.base)};
    p.platform.setAuthToken(JSON.parse(process.env.PHONE_TOKENS)[b].alice);
    await uploadLocalToServer({ serverUrl: b, authToken: p.platform.getAuthToken() });
    const me = await (await fetch(b + '/api/auth/me', { headers: { Authorization: 'Bearer ' + p.platform.getAuthToken() } })).json();
    await p.la.claimForServer(b, me.user.id, { created: me.user.created_at });
    localStorage.setItem('note:cachedUser', JSON.stringify(me.user));
    p.platform.setServerUrl(b);
    await p.sync(); await p.sync();
    p.done(await p.shown());`);
  assert.deepEqual(r, ['alice note 1', 'alice note 2', 'alice on server b']);
  assert.deepEqual(B.q(`SELECT title, COUNT(*) AS n FROM notes WHERE title LIKE 'alice note %' AND deleted_at IS NULL GROUP BY title ORDER BY title`),
    [{ title: 'alice note 1', n: 1 }, { title: 'alice note 2', n: 1 }], 'each went up once');
  assert.deepEqual(owners(A, 'alice on server b'), [], 'nothing of server b reached server a');
});

test('the same user id made at another time (a rebuilt server) is another account', async (t) => {
  if (skip(t)) return;
  const r = phone('rebuilt', A, `
    await p.setupSignIn('bob'); await p.sync();
    const owner = JSON.parse(await p.dbn.dbGetMeta('account'));
    const rebuilt = { ...JSON.parse(localStorage.getItem('note:cachedUser')), created_at: '2030-01-01 00:00:00' };
    localStorage.setItem('note:cachedUser', JSON.stringify(rebuilt));
    const syncs = await p.la.localDataIsThisAccount();
    const m = await p.la.matchOwner(owner, rebuilt.id, p.S, rebuilt.created_at);
    p.done({ syncs, same: m.same, ready: p.la.accountReadyFor(p.get(p.la.accountGate), rebuilt) });`);
  assert.deepEqual(r, { syncs: false, same: false, ready: false }, 'no sync and no data until the account check runs again');
});

// ── Each row once ──────────────────────────────────────────────────────

test('the first sync stores every note once, whatever starts it', async (t) => {
  if (skip(t)) return;
  for (let i = 1; i <= 6; i++) await note(A, 'carol', `carol note ${i}`);
  const r = phone('first', A, `
    await p.setupSignIn('carol');
    // What the app starts at once on opening: App.svelte's sync, the API
    // layer's first sync and its loop, coming back to the app, a manual
    // Sync Now.
    // Five first syncs in a row (the copy emptied in between), so a race
    // that only sometimes lines up can't hide.
    const rounds = [];
    for (let round = 0; round < 5; round++) {
      await p.db.run('DELETE FROM notes', []);
      await p.db.run("DELETE FROM sync_meta WHERE key = 'last_pull_at'", []);
      await Promise.all([p.syncMod.fullSync(), p.syncMod.fullSync(true), p.syncMod.fullSync(true), p.sync(), p.sync(), p.sync()]);
      await p.sleep(200);
      const rows = await p.rows();
      rounds.push({ count: rows.length, servers: new Set(rows.map(x => x.server_id)).size });
    }
    p.done(rounds);`, { PHONE_DELAY_MS: '30', PHONE_BRIDGE_MS: '2' });
  assert.deepEqual(r, Array(5).fill({ count: 6, servers: 6 }));
});

test('a note made offline goes up once, with several syncs at once', async (t) => {
  if (skip(t)) return;
  const r = phone('offline', A, `
    await p.setupSignIn('carol'); await p.sync();
    // Five times over, so a race that only sometimes lines up can't hide.
    for (let round = 0; round < 5; round++) {
      await p.offline(() => p.NotesNative.createNote({ title: 'carol offline once ' + round }));
      await Promise.all([p.sync(), p.syncMod.fullSync(true), p.syncMod.fullSync(), p.sync(), p.sync()]);
    }
    await p.sleep(300); await p.sync();
    const rows = (await p.rows()).filter(x => x.title.startsWith('carol offline once '));
    p.done({ phone: rows.length, synced: rows.every(x => x.sync_status === 'synced') });`, { PHONE_DELAY_MS: '30', PHONE_BRIDGE_MS: '2' });
  assert.deepEqual(r, { phone: 5, synced: true });
  const made = A.q(`SELECT title, COUNT(*) AS n FROM notes WHERE title LIKE 'carol offline once %' AND deleted_at IS NULL GROUP BY title`);
  assert.deepEqual(made.map(m => m.n), [1, 1, 1, 1, 1], 'each went up once');
});

test('a create whose answer was lost is made once, and the pull matches it to the phone row', async (t) => {
  if (skip(t)) return;
  const r = phone('lost', A, `
    await p.setupSignIn('carol'); await p.sync();
    const made = await p.NotesNative.createNote({ title: 'carol lost answer' });
    const before = (await p.rows()).find(x => x.id === made.id).created_at;
    p.net.dropAnswer = u => u.includes('/api/sync/push');
    await p.sync();
    await p.sync(); await p.sync();
    const rows = (await p.rows()).filter(x => x.title === 'carol lost answer');
    p.done({ phone: rows.length, createdAtKept: rows[0]?.created_at === before });`);
  assert.deepEqual(r, { phone: 1, createdAtKept: true });
  assert.deepEqual(owners(A, 'carol lost answer'), ['carol']);
});

test('a pull never changes when a phone row was made', async (t) => {
  if (skip(t)) return;
  const r = phone('created', A, `
    await p.setupSignIn('carol'); await p.sync();
    const made = await p.NotesNative.createNote({ title: 'carol created at' });
    const before = (await p.rows()).find(x => x.id === made.id).created_at;
    await p.sleep(1100);
    await p.sync(); await p.sync();
    p.done((await p.rows()).find(x => x.id === made.id).created_at === before);`);
  assert.equal(r, true);
});

test('stress: many syncs at once on a slow network, with edits, make nothing twice', async (t) => {
  if (skip(t)) return;
  const r = phone('stress', A, `
    await p.setupSignIn('carol');
    for (let round = 0; round < 3; round++) {
      const work = [];
      for (let i = 0; i < 4; i++) work.push(p.NotesNative.createNote({ title: 'stress ' + round + '-' + i }));
      for (let i = 0; i < 8; i++) work.push(p.sync());
      await Promise.all(work);
    }
    await p.sync(); await p.sync();
    const rows = (await p.rows()).filter(x => x.title.startsWith('stress '));
    p.done({ phone: rows.length, distinct: new Set(rows.map(x => x.title)).size, pending: rows.filter(x => x.sync_status !== 'synced').length });`, { PHONE_DELAY_MS: '40' });
  assert.deepEqual(r, { phone: 12, distinct: 12, pending: 0 });
  const made = A.q(`SELECT title, COUNT(*) AS n FROM notes WHERE title LIKE 'stress %' AND deleted_at IS NULL GROUP BY title`);
  assert.equal(made.length, 12);
  assert.ok(made.every(m => m.n === 1), JSON.stringify(made.filter(m => m.n > 1)));
});

test("a restored copy of the database gets its own install id (a marker backups leave out)", async (t) => {
  if (skip(t)) return;
  const first = phone('marker', A, `p.done(await p.dbn.dbInstallId?.())`);
  for (const f of readdirSync(dir).filter(f => f.startsWith('phone-marker') && f.endsWith('.db'))) {
    copyFileSync(join(dir, f), join(dir, f.replace('phone-marker', 'phone-restored')));
  }
  const again = phone('marker', A, `p.done(await p.dbn.dbInstallId?.())`);
  const restored = phone('restored', A, `p.done(await p.dbn.dbInstallId?.())`);
  assert.ok(first);
  assert.equal(again, first, 'the same install keeps its id');
  assert.ok(restored && restored !== first, 'a copy without the marker takes a new one');
});

// ── The server's side ──────────────────────────────────────────────────

const push = (srv, user, notes) => web(srv, user, 'POST', '/api/sync/push', { tables: { notes } });
const pull = (srv, user, q = '') => web(srv, user, 'GET', `/api/sync/pull?since=1970-01-01T00:00:00${q}`);

test('the server makes a keyed create once per account, and tells only that account the key', async (t) => {
  if (skip(t)) return;
  const row = { client_id: 7, server_id: null, client_key: 'install-x:notes:7@2026-10-08 10:00:00', title: 'keyed once', body_md: '', kind: 'text', updated_at: '2026-10-08 10:00:00' };
  const first = await push(A, 'carol', [row]);
  const again = await push(A, 'carol', [row]);
  const other = await push(A, 'bob', [row]);
  assert.equal(first.tables.notes[0].server_id, again.tables.notes[0].server_id, 'the same key: the same row');
  assert.notEqual(other.tables.notes[0].server_id, first.tables.notes[0].server_id, "another account's key is its own");
  assert.deepEqual(owners(A, 'keyed once'), ['bob', 'carol']);
  const mine = (await pull(A, 'carol', '&keys=1')).tables.notes.find(n => n.title === 'keyed once');
  assert.equal(mine.client_key, row.client_key, 'the app that asks gets its key back');
  const old = (await pull(A, 'carol')).tables.notes.find(n => n.title === 'keyed once');
  assert.equal('client_key' in old, false, 'an older app, which stores every column it gets, never gets it');
  // Shared with alice: she sees the note, not carol's install key.
  await web(A, 'carol', 'POST', `/api/notes/${first.tables.notes[0].server_id}/members`, { username: 'alice', role: 'view' });
  const theirs = (await pull(A, 'alice', '&keys=1')).tables.notes.find(n => n.title === 'keyed once');
  assert.ok(theirs);
  assert.equal(theirs.client_key ?? null, null);
});

test('the server reports an instance id that stays the same', async (t) => {
  if (skip(t)) return;
  const a1 = await (await fetch(A.base + '/api/auth/status')).json();
  const a2 = await (await fetch(A.base + '/api/auth/status')).json();
  const b = await (await fetch(B.base + '/api/auth/status')).json();
  assert.ok(a1.instance_id);
  assert.equal(a1.instance_id, a2.instance_id);
  assert.notEqual(a1.instance_id, b.instance_id);
  assert.equal(a1.sync_version, 2);
});
