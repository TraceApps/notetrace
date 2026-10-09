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
      await p.sync(); await p.sleep(300); // nothing still running from the round before
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

// ── Settings, reminders and the diagnostic log across accounts ─────────

test("the previous account's setting changed offline survives another account's sign-in and Cancel, and goes up as theirs", async (t) => {
  if (skip(t)) return;
  await web(A, 'alice', 'PUT', '/api/settings', { key: 'dateFormat', value: 'EU' });
  await web(A, 'bob', 'PUT', '/api/settings', { key: 'dateFormat', value: 'US' });
  const r = phone('setting-cancel', A, `
    await p.setupSignIn('bob'); await p.sync();
    await p.offline(async () => { p.settings.dateFormat.set('ISO'); await p.sleep(900); await p.logout(); });
    p.answerWaiting(false);
    await p.NotesNative.createNote({ title: 'keeps the ask' });
    const ok = await p.loginSignIn('alice');
    await p.sleep(300);
    const pendingAfterCancel = (await p.rows('user_settings')).filter(x => x.key === 'dateFormat').map(x => ({ value: x.value, status: x.sync_status }));
    await p.loginSignIn('bob'); await p.sync(); await p.sleep(300);
    const { DB } = await import(p.SRC + 'lib/db.js');
    p.done({ ok, pendingAfterCancel, shown: DB.getSetting('dateFormat', null) });`);
  const bobOnServer = A.q(`SELECT s.value FROM user_settings s JOIN users u ON u.id = s.user_id WHERE u.username = 'bob' AND s.key = 'dateFormat'`).map(x => JSON.parse(x.value));
  assert.deepEqual({ ...r, bobOnServer }, { ok: false, pendingAfterCancel: [{ value: '"ISO"', status: 'pending' }], shown: 'ISO', bobOnServer: ['ISO'] });
});

test('a setting sent straight to the server is marked sent on the phone', async (t) => {
  if (skip(t)) return;
  const r = phone('setting-sent', A, `
    await p.setupSignIn('carol'); await p.sync();
    // Only the direct push: no sync can send it (and mark it) meanwhile.
    p.net.block = u => u.includes('/api/sync/');
    p.settings.timeFormat.set('24h');
    await p.sleep(1500);
    p.done((await p.rows('user_settings')).filter(x => x.key === 'timeFormat').map(x => x.sync_status));`);
  assert.deepEqual(r, ['synced']);
});

test("signing out stops the account's reminders; another account gets only its own once its copy is current", async (t) => {
  if (skip(t)) return;
  const soon = new Date(Date.now() + 86400000).toISOString().replace('T', ' ').slice(0, 19);
  await web(A, 'alice', 'POST', '/api/notes', { title: 'alice reminder', body_md: '', reminder_at: soon });
  const r = phone('reminders', A, `
    await p.setupSignIn('bob'); await p.sync();
    await p.NotesNative.createNote({ title: 'bob reminder', reminder_at: ${JSON.stringify(soon)} });
    p.reminders.rescheduleReminders(); await p.sleep(700);
    const bobArmed = globalThis.__reminders.at(-1);
    await p.logout(); await p.sleep(700);
    const afterSignOut = globalThis.__reminders.at(-1);
    p.answerWaiting(true);
    await p.loginSignIn('alice'); await p.sync(); await p.sleep(200);
    p.reminders.rescheduleReminders(); await p.sleep(700);
    p.done({ bobArmed, afterSignOut, alice: globalThis.__reminders.at(-1), everArmedBobAfterSignOut: globalThis.__reminders.slice(globalThis.__reminders.indexOf(afterSignOut)).some(l => l.includes('bob reminder')) });`);
  assert.deepEqual(r, { bobArmed: ['bob reminder'], afterSignOut: [], alice: ['alice reminder'], everArmedBobAfterSignOut: false });
});

test('the diagnostic log never holds a secret, in verbose mode either', async (t) => {
  if (skip(t)) return;
  const r = phone('log', A, `
    const log = await import(p.SRC + 'lib/log-capture.js');
    log.setVerboseLogging(true);
    await p.setupSignIn('carol'); await p.sync();
    p.settings.aiApiKey.set('sk-proj-NEVERLOGTHIS1234567890');
    await p.sleep(1200);
    console.log('[app] deep link received:', 'notetrace://oidc-callback/?code=NEVERCODE123&id_token_hint=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLWhlcmU');
    const text = log.getLogBufferText();
    p.done({ key: text.includes('NEVERLOGTHIS'), code: text.includes('NEVERCODE'), idToken: text.includes('eyJhbGciOiJSUzI1NiJ9'), named: /aiApiKey/.test(text) });`);
  assert.deepEqual(r, { key: false, code: false, idToken: false, named: true }, 'the key name shows, never its value');
});

// ── The last small ones ────────────────────────────────────────────────

test('closing "Is This the Same Server?" without an answer clears nothing, sends nothing, and asks again', async (t) => {
  if (skip(t)) return;
  const viaLocalhost = A.base.replace('127.0.0.1', 'localhost');
  const r = phone('dismiss', A, `
    p.net.noInstanceId = true;
    await p.setupSignIn('alice'); await p.sync();
    await p.offline(() => p.NotesNative.createNote({ title: 'alice waiting through a dismiss' }));
    const before = (await p.rows()).map(n => n.title + ':' + n.sync_status).sort();
    p.platform.setServerUrl(${JSON.stringify(viaLocalhost)});
    p.answerSameServer(null);
    const ok = await p.loginSignIn('alice');
    const signedOut = !p.platform.getAuthToken();
    const after = (await p.rows()).map(n => n.title + ':' + n.sync_status).sort();
    const kept = after.length === before.length && after.every((x, i) => x === before[i]) && after.includes('alice waiting through a dismiss:pending');
    const again = await p.loginSignIn('alice');
    p.done({ ok, signedOut, kept, again, asked: p.asked });`);
  assert.deepEqual(r, {
    ok: false, signedOut: true,
    kept: true,
    again: false, asked: [{ kind: 'same_server' }, { kind: 'same_server' }],
  });
  assert.deepEqual(owners(A, 'alice waiting through a dismiss'), [], 'nothing went up');
});

test('Disconnect, then Connect again to the same account with Upload: only what was made since goes up, once', async (t) => {
  if (skip(t)) return;
  for (const n of [1, 2]) await note(A, 'carol', `carol before disconnect ${n}`);
  const r = phone('reconnect', A, `
    await p.setupSignIn('carol'); await p.sync();
    // Settings > Server > Disconnect & Use Locally.
    await p.la?.setLocalOwner?.();
    p.platform.setServerUrl(null); p.platform.setAuthToken(null); p.platform.setNativeMode('local');
    await p.NotesNative.createNote({ title: 'carol made while disconnected' });
    const before = (await p.rows()).find(n => n.title === 'carol before disconnect 1');
    await p.NotesNative.updateNote(before.id, { title: 'carol before disconnect 1 (edited offline)' });
    // Settings > Server > Connect as carol, Upload Phone to Server (SettingsServerConnection.svelte).
    const tok = JSON.parse(process.env.PHONE_TOKENS)[p.S].carol;
    p.platform.setAuthToken(tok);
    const me = await (await fetch(p.S + '/api/auth/me', { headers: { Authorization: 'Bearer ' + tok } })).json();
    const same = p.la?.cameFromThisAccount ? await p.la.cameFromThisAccount(p.S, me.user) : false;
    const { uploadLocalToServer } = await import(p.SRC + 'lib/migrate.js');
    await uploadLocalToServer({ serverUrl: p.S, authToken: tok, keepIds: same });
    await p.la?.claimForServer?.(p.S, me.user.id, { created: me.user.created_at, sameAccount: same });
    localStorage.setItem('note:cachedUser', JSON.stringify(me.user));
    p.platform.setServerUrl(p.S); p.platform.setNativeMode('server');
    await p.sync(); await p.sync();
    p.done({ same, phone: (await p.rows()).filter(n => /^carol (before|made)/.test(n.title)).map(n => n.title).sort() });`);
  assert.equal(r.same, true);
  assert.deepEqual(r.phone, ['carol before disconnect 1 (edited offline)', 'carol before disconnect 2', 'carol made while disconnected']);
  const onServer = A.q(`SELECT n.title, COUNT(*) AS n FROM notes n JOIN users u ON u.id = n.user_id WHERE u.username = 'carol' AND n.title LIKE 'carol %' AND n.title NOT LIKE 'carol note %' AND n.title NOT LIKE 'carol offline%' AND n.title NOT LIKE 'carol lost%' AND n.title NOT LIKE 'carol created%' AND n.deleted_at IS NULL GROUP BY n.title ORDER BY n.title`);
  assert.deepEqual(onServer, [
    { title: 'carol before disconnect 1 (edited offline)', n: 1 },
    { title: 'carol before disconnect 2', n: 1 },
    { title: 'carol made while disconnected', n: 1 },
  ], 'no second copy of anything');
});

test('a forced sync asked for while one runs runs again right after it, never alongside', async (t) => {
  if (skip(t)) return;
  const r = phone('forced', A, `
    await p.setupSignIn('carol'); await p.sync();
    const S = p.S, tok = JSON.parse(process.env.PHONE_TOKENS)[S].carol;
    let inPull = 0, most = 0;
    const real = globalThis.fetch;
    globalThis.fetch = async (u, i) => { const pull = String(u).includes('/api/sync/pull'); if (pull) { inPull++; most = Math.max(most, inPull); } try { return await real(u, i); } finally { if (pull) inPull--; } };
    const first = p.syncMod.fullSync(true);
    await p.sleep(5);
    await fetch(S + '/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ title: 'made during a sync', body_md: '' }) });
    const forced = await p.syncMod.fullSync(false, true, true);
    await first;
    p.done({ ok: forced.ok, here: (await p.rows()).some(n => n.title === 'made during a sync'), most });`, { PHONE_DELAY_MS: '40' });
  assert.deepEqual(r, { ok: true, here: true, most: 1 });
});

test('a list setting changed on the phone reaches the server as a list, not as text', async (t) => {
  if (skip(t)) return;
  const r = phone('list-setting', A, `
    await p.setupSignIn('carol'); await p.sync();
    await p.offline(async () => { p.settings.noteOrder.set([3, 1, 2]); p.settings.noteTemplates.set([{ id: 't1', name: 'Daily', body: 'x' }]); await p.sleep(900); });
    await p.sync(); await p.sleep(300);
    const res = await fetch(p.S + '/api/settings', { headers: { Authorization: 'Bearer ' + p.platform.getAuthToken() } });
    const all = await res.json();
    p.done({ noteOrder: all.noteOrder, noteTemplates: all.noteTemplates });`);
  assert.deepEqual(r, { noteOrder: [3, 1, 2], noteTemplates: [{ id: 't1', name: 'Daily', body: 'x' }] });
});

test('Disconnect keeps which account the data came from; a sync meanwhile, or a restored backup, never mixes it up', async (t) => {
  if (skip(t)) return;
  const r = phone('origin', A, `
    await p.setupSignIn('carol'); await p.sync();
    const tok = p.platform.getAuthToken();
    const me = await (await fetch(p.S + '/api/auth/me', { headers: { Authorization: 'Bearer ' + tok } })).json();
    await p.la.setLocalOwner();
    // A sync that still runs with the old session (a timer) between Disconnect and the reload.
    const during = await p.syncMod.fullSync(true);
    const keptWas = !!JSON.parse(await p.dbn.dbGetMeta('account')).was;
    const same = await p.la.cameFromThisAccount(p.S, me.user);
    const { importLocalSnapshot } = await import(p.SRC + 'lib/local-backup.js');
    await importLocalSnapshot({ format: 'notetrace-local-snapshot', tables: {} });
    const afterRestore = await p.la.cameFromThisAccount(p.S, me.user);
    p.done({ during: during.reason, keptWas, same, afterRestore });`);
  assert.deepEqual(r, { during: 'other_account', keptWas: true, same: true, afterRestore: false });
});

test('closing "Is This the Same Server?" while connecting from Settings decides nothing', async (t) => {
  if (skip(t)) return;
  const viaLocalhost = A.base.replace('127.0.0.1', 'localhost');
  const r = phone('connect-dismiss', A, `
    p.net.noInstanceId = true;
    await p.setupSignIn('carol'); await p.sync();
    const tok = p.platform.getAuthToken();
    const me = await (await fetch(p.S + '/api/auth/me', { headers: { Authorization: 'Bearer ' + tok } })).json();
    await p.la.setLocalOwner();
    const answer = await p.la.cameFromThisAccount(${JSON.stringify(viaLocalhost)}, me.user, { sameServer: async () => null });
    p.done({ answer });`);
  assert.deepEqual(r, { answer: null }, 'the connect stops (SettingsServerConnection.svelte cancels it)');
});

test('a forced sync asked for before a change of account never runs after it', async (t) => {
  if (skip(t)) return;
  const r = phone('forced-stop', A, `
    await p.setupSignIn('carol'); await p.sync();
    const first = p.syncMod.fullSync(true);
    const forced = p.syncMod.fullSync(false, true, true);
    p.la.bumpAccountGeneration();
    await p.syncMod.stopSync();
    await first;
    p.done((await forced).reason);`, { PHONE_DELAY_MS: '40' });
  assert.equal(r, 'stopped');
});

// ── A note edited on the phone and deleted elsewhere; restored backups ──

const liveItems = (srv, noteId) => srv.q(`SELECT text FROM checklist_items WHERE note_id = ? AND deleted_at IS NULL ORDER BY text`, noteId).map(r => r.text);
const noteRow = (srv, id) => srv.q(`SELECT title, deleted_at IS NOT NULL AS gone FROM notes WHERE id = ?`, id)[0];
const list = async (title) => web(A, 'carol', 'POST', '/api/notes', { title, kind: 'checklist', items: [{ text: 'eggs' }, { text: 'milk' }] });

test('an edit made on the phone after the note was deleted elsewhere brings it back, items and all, everywhere', async (t) => {
  if (skip(t)) return;
  const n = await list('A1 list');
  const r = phone('a1', A, `
    await p.setupSignIn('carol'); await p.sync();
    const local = (await p.rows()).find(x => x.server_id === ${n.id});
    await p.offline(async () => {
      // Deleted on the web while this phone is offline, then edited here.
      await p.net.web(p.S + '/api/notes/${n.id}/forever', { method: 'DELETE', headers: { Authorization: 'Bearer ' + p.platform.getAuthToken() } });
      await p.sleep(1100);
      await p.NotesNative.updateNote(local.id, { title: 'A1 list edited' });
      const milk = (await p.NotesNative.getNote(local.id)).items.find(i => i.text === 'milk');
      await p.NotesNative.updateItem(local.id, milk.uuid, { text: 'oat milk' });
    });
    await p.sync(); await p.sync();
    p.done({ shown: (await p.shown()).filter(x => x.startsWith('A1')), items: await p.items(local.id), waiting: await p.waiting(), dropped: p.dropped });`);
  assert.deepEqual({ ...r, server: noteRow(A, n.id), serverItems: liveItems(A, n.id) }, {
    shown: ['A1 list edited'], items: ['eggs', 'oat milk'], waiting: 0, dropped: [],
    server: { title: 'A1 list edited', gone: 0 }, serverItems: ['eggs', 'oat milk'],
  });
});

test('an edit older than the delete is dropped on the phone, reported, and never left waiting', async (t) => {
  if (skip(t)) return;
  const n = await list('A2 list');
  const r = phone('a2', A, `
    await p.setupSignIn('carol'); await p.sync();
    const local = (await p.rows()).find(x => x.server_id === ${n.id});
    await p.offline(async () => {
      await p.NotesNative.updateNote(local.id, { title: 'A2 list edited' });
      const milk = (await p.NotesNative.getNote(local.id)).items.find(i => i.text === 'milk');
      await p.NotesNative.updateItem(local.id, milk.uuid, { text: 'oat milk' });
      await p.sleep(1100);
      // Deleted on the web after the phone's offline edit.
      await p.net.web(p.S + '/api/notes/${n.id}/forever', { method: 'DELETE', headers: { Authorization: 'Bearer ' + p.platform.getAuthToken() } });
    });
    await p.sync(); await p.sync();
    p.done({ shown: (await p.shown()).filter(x => x.startsWith('A2')), waiting: await p.waiting(), dropped: p.dropped });`);
  assert.deepEqual({ ...r, server: noteRow(A, n.id) }, {
    shown: [], waiting: 0, dropped: ['A2 list edited'], server: { title: 'A2 list', gone: 1 },
  });
});

test('only a checklist item edited after the delete still brings the note back', async (t) => {
  if (skip(t)) return;
  const n = await list('A3 list');
  const r = phone('a3', A, `
    await p.setupSignIn('carol'); await p.sync();
    const local = (await p.rows()).find(x => x.server_id === ${n.id});
    await p.offline(async () => {
      await p.net.web(p.S + '/api/notes/${n.id}/forever', { method: 'DELETE', headers: { Authorization: 'Bearer ' + p.platform.getAuthToken() } });
      await p.sleep(1100);
      const eggs = (await p.NotesNative.getNote(local.id)).items.find(i => i.text === 'eggs');
      await p.NotesNative.updateItem(local.id, eggs.uuid, { checked: true });
    });
    await p.sync(); await p.sync();
    p.done({ shown: (await p.shown()).filter(x => x.startsWith('A3')), waiting: await p.waiting() });`);
  assert.deepEqual({ ...r, server: noteRow(A, n.id), serverItems: liveItems(A, n.id) }, {
    shown: ['A3 list'], waiting: 0, server: { title: 'A3 list', gone: 0 }, serverItems: ['eggs', 'milk'],
  });
});

test("a row the server no longer has, or another account's, goes up once as this account's and never touches the other", async (t) => {
  if (skip(t)) return;
  const alices = await web(A, 'alice', 'POST', '/api/notes', { title: 'alice private A4', body_md: 'hers' });
  const r = phone('a4', A, `
    await p.setupSignIn('carol'); await p.sync();
    const lost = await p.NotesNative.createNote({ title: 'A4 lost on the server' });
    const foreign = await p.NotesNative.createNote({ title: 'A4 points at alice' });
    await p.db.run('UPDATE notes SET server_id = 987654 WHERE id = ?', [lost.id]);
    await p.db.run('UPDATE notes SET server_id = ? WHERE id = ?', [${alices.id}, foreign.id]);
    await p.sync(); await p.sync(); await p.sync();
    p.done({ waiting: await p.waiting() });`);
  assert.equal(r.waiting, 0);
  assert.deepEqual(owners(A, 'A4 lost on the server'), ['carol']);
  assert.deepEqual(owners(A, 'A4 points at alice'), ['carol']);
  assert.deepEqual(A.q(`SELECT title, body_md FROM notes WHERE id = ?`, alices.id), [{ title: 'alice private A4', body_md: 'hers' }], "alice's note untouched");
});

test('a backup from this account restored while connected keeps its ids, catches up with the server, and makes nothing twice', async (t) => {
  if (skip(t)) return;
  const keep = await web(A, 'carol', 'POST', '/api/notes', { title: 'B1 kept', body_md: 'v1' });
  const gone = await web(A, 'carol', 'POST', '/api/notes', { title: 'B1 deleted later', body_md: '' });
  const r = phone('b1', A, `
    await p.setupSignIn('carol'); await p.sync();
    const { exportLocalSnapshot, importLocalSnapshot } = await import(p.SRC + 'lib/local-backup.js');
    const snap = JSON.parse(JSON.stringify(await exportLocalSnapshot({ includeImages: false })));
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.platform.getAuthToken() };
    await fetch(p.S + '/api/notes/${keep.id}', { method: 'PATCH', headers: H, body: JSON.stringify({ body_md: 'v2 from the web' }) });
    await fetch(p.S + '/api/notes/${gone.id}/forever', { method: 'DELETE', headers: H });
    await p.sync();
    await importLocalSnapshot(snap);
    await p.sync(); await p.sync();
    const rows = await p.rows();
    p.done({ shown: (await p.shown()).filter(x => x.startsWith('B1')), kept: rows.find(x => x.title === 'B1 kept')?.body_md, waiting: await p.waiting() });`);
  assert.deepEqual(r, { shown: ['B1 kept'], kept: 'v2 from the web', waiting: 0 });
  assert.deepEqual(A.q(`SELECT title, COUNT(*) AS n FROM notes WHERE title LIKE 'B1 %' GROUP BY title ORDER BY title`), [{ title: 'B1 deleted later', n: 1 }, { title: 'B1 kept', n: 1 }]);
});

test("a backup from another account, or with no account, goes up as new once and never writes into the other account's notes", async (t) => {
  if (skip(t)) return;
  await web(A, 'alice', 'POST', '/api/notes', { title: 'B2 alice note', body_md: 'alice body' });
  const snapFile = join(dir, 'alice-snapshot.json');
  phone('b2-alice', A, `
    await p.setupSignIn('alice'); await p.sync();
    const one = (await p.rows()).find(x => x.title === 'B2 alice note');
    await p.NotesNative.updateNote(one.id, { body_md: 'edited in the backup' });
    const { exportLocalSnapshot } = await import(p.SRC + 'lib/local-backup.js');
    (await import('node:fs')).writeFileSync(${JSON.stringify(snapFile)}, JSON.stringify(await exportLocalSnapshot({ includeImages: false })));
    p.done(true);`);
  const aliceBefore = A.q(`SELECT id, title, body_md, deleted_at FROM notes n WHERE user_id = (SELECT id FROM users WHERE username = 'alice') ORDER BY id`);
  const r = phone('b2', A, `
    await p.setupSignIn('carol'); await p.sync();
    const { importLocalSnapshot } = await import(p.SRC + 'lib/local-backup.js');
    const snap = JSON.parse((await import('node:fs')).readFileSync(${JSON.stringify(snapFile)}, 'utf8'));
    await importLocalSnapshot(snap); await p.sync(); await p.sync();
    await importLocalSnapshot(snap); await p.sync(); await p.sync();
    const untagged = { ...snap }; delete untagged.account;
    await importLocalSnapshot(untagged); await p.sync(); await p.sync();
    p.done({ waiting: await p.waiting(), shown: (await p.shown()).filter(x => x.startsWith('B2')) });`);
  assert.deepEqual(r, { waiting: 0, shown: ['B2 alice note'] });
  assert.deepEqual(A.q(`SELECT title, body_md, COUNT(*) AS n FROM notes WHERE user_id = (SELECT id FROM users WHERE username = 'carol') AND title = 'B2 alice note' GROUP BY title, body_md`),
    [{ title: 'B2 alice note', body_md: 'edited in the backup', n: 1 }], "once in carol's account, whatever the re-runs");
  assert.deepEqual(A.q(`SELECT id, title, body_md, deleted_at FROM notes n WHERE user_id = (SELECT id FROM users WHERE username = 'alice') ORDER BY id`), aliceBefore, "alice's notes untouched");
});

test("deleting a note forever on the phone deletes it on the server, quietly, and never brings it back", async (t) => {
  if (skip(t)) return;
  const n = await list('A5 list');
  const r = phone('a5', A, `
    await p.setupSignIn('carol'); await p.sync();
    const local = (await p.rows()).find(x => x.server_id === ${n.id});
    await p.NotesNative.trashNote(local.id);
    await p.NotesNative.deleteNoteForever(local.id);
    await p.sleep(1100);
    await p.sync(); await p.sync();
    p.done({ waiting: await p.waiting(), dropped: p.dropped });`, { PHONE_DELAY_MS: '40' });
  assert.deepEqual({ ...r, server: noteRow(A, n.id), serverItems: liveItems(A, n.id) }, { waiting: 0, dropped: [], server: { title: 'A5 list', gone: 1 }, serverItems: [] });
});

test("a note that points at another account's note goes up as this account's with its items, and the other account's stays as it was", async (t) => {
  if (skip(t)) return;
  const alices = await web(A, 'alice', 'POST', '/api/notes', { title: 'alice list A6', kind: 'checklist', items: [{ text: 'hers' }] });
  const r = phone('a6', A, `
    await p.setupSignIn('carol'); await p.sync();
    const mine = await p.offline(() => p.NotesNative.createNote({ title: 'A6 points at alice', kind: 'checklist', items: [{ text: 'tea' }, { text: 'jam' }] }));
    await p.db.run('UPDATE notes SET server_id = ? WHERE id = ?', [${alices.id}, mine.id]);
    await p.sync(); await p.sync(); await p.sync();
    p.done({ waiting: await p.waiting(), items: await p.items(mine.id), copies: (await p.db.query('SELECT COUNT(*) AS n FROM notes WHERE title = ?', ['A6 points at alice'])).values[0].n });`);
  assert.deepEqual(r, { waiting: 0, items: ['jam', 'tea'], copies: 1 });
  const carolsNotes = A.q(`SELECT id FROM notes WHERE title = 'A6 points at alice' AND user_id = (SELECT id FROM users WHERE username = 'carol') AND deleted_at IS NULL`);
  assert.equal(carolsNotes.length, 1);
  assert.deepEqual(liveItems(A, carolsNotes[0].id), ['jam', 'tea']);
  assert.deepEqual({ note: noteRow(A, alices.id), items: liveItems(A, alices.id) }, { note: { title: 'alice list A6', gone: 0 }, items: ['hers'] });
});

test('a note edit older than the delete with an item edit newer than it: the note comes back with both', async (t) => {
  if (skip(t)) return;
  const n = await list('A7 list');
  const r = phone('a7', A, `
    await p.setupSignIn('carol'); await p.sync();
    const local = (await p.rows()).find(x => x.server_id === ${n.id});
    await p.offline(async () => {
      await p.NotesNative.updateNote(local.id, { title: 'A7 list edited first' });
      await p.sleep(1100);
      await p.net.web(p.S + '/api/notes/${n.id}/forever', { method: 'DELETE', headers: { Authorization: 'Bearer ' + p.platform.getAuthToken() } });
      await p.sleep(1100);
      const eggs = (await p.NotesNative.getNote(local.id)).items.find(i => i.text === 'eggs');
      await p.NotesNative.updateItem(local.id, eggs.uuid, { text: 'brown eggs' });
    });
    await p.sync(); await p.sync();
    p.done({ shown: (await p.shown()).filter(x => x.startsWith('A7')), items: await p.items(local.id), waiting: await p.waiting(), dropped: p.dropped });`);
  assert.deepEqual({ ...r, server: noteRow(A, n.id), serverItems: liveItems(A, n.id) }, {
    shown: ['A7 list edited first'], items: ['brown eggs', 'milk'], waiting: 0, dropped: [],
    server: { title: 'A7 list edited first', gone: 0 }, serverItems: ['brown eggs', 'milk'],
  });
});

test('a backup taken in local mode after a Disconnect from this account counts as this account\'s', async (t) => {
  if (skip(t)) return;
  await web(A, 'carol', 'POST', '/api/notes', { title: 'B4 from the web', body_md: '' });
  const r = phone('b4', A, `
    await p.setupSignIn('carol'); await p.sync();
    await p.la.setLocalOwner();
    const { exportLocalSnapshot, importLocalSnapshot } = await import(p.SRC + 'lib/local-backup.js');
    const snap = JSON.parse(JSON.stringify(await exportLocalSnapshot({ includeImages: false })));
    // Connected again as carol (the account check claims the copy).
    const me = await (await fetch(p.S + '/api/auth/me', { headers: { Authorization: 'Bearer ' + p.platform.getAuthToken() } })).json();
    await p.la.claimForServer(p.S, me.user.id, { created: me.user.created_at, sameAccount: true });
    const res = await importLocalSnapshot(snap);
    await p.sync(); await p.sync();
    p.done({ as: res.as, waiting: await p.waiting() });`);
  assert.deepEqual(r, { as: 'same', waiting: 0 });
  assert.deepEqual(A.q(`SELECT COUNT(*) AS n FROM notes WHERE title = 'B4 from the web'`), [{ n: 1 }]);
});

// ── Trace chat deleted on the server ───────────────────────────────────
// Trace reads and clears chat on the server; the phone keeps a synced copy
// (which Connect with Upload and Push All send up again). Chat deleted on
// the server (Clear Chat, the trim to the newest messages) has to leave
// that copy, or it stays on the phone and in its backups, and can come
// back. And chat the phone sends up was refused by the server.

const chat = (srv, user, content) => web(srv, user, 'POST', '/api/ai/history', { role: 'user', content });
const chatOn = (srv, user) => srv.q(`SELECT c.content FROM ai_chat_history c JOIN users u ON u.id = c.user_id WHERE u.username = ? ORDER BY c.id`, user).map(r => r.content);

test('chat cleared on the web leaves the phone at the next sync, and only that account\'s', async (t) => {
  if (skip(t)) return;
  for (const m of ['bob asks 1', 'bob asks 2']) await chat(A, 'bob', m);
  await chat(A, 'alice', 'alice asks');
  const first = phone('chat-bob', A, `
    await p.setupSignIn('bob'); await p.sync();
    p.done((await p.rows('ai_chat_history')).map(r => r.content));`);
  await web(A, 'bob', 'DELETE', '/api/ai/history');
  await chat(A, 'bob', 'bob asks again');
  const after = phone('chat-bob', A, `
    await p.loginSignIn('bob'); await p.sync();
    p.done((await p.rows('ai_chat_history')).map(r => r.content));`);
  assert.deepEqual(first, ['bob asks 1', 'bob asks 2']);
  assert.deepEqual(after, ['bob asks again'], 'the cleared messages are gone, the new one is there');
  assert.deepEqual(chatOn(A, 'alice'), ['alice asks'], "another account's chat is untouched");
});

test('chat cleared while the phone was disconnected is gone after it connects again', async (t) => {
  if (skip(t)) return;
  await chat(A, 'carol', 'carol asks before');
  const before = phone('chat-carol', A, `
    await p.setupSignIn('carol'); await p.sync();
    await p.la?.setLocalOwner?.();
    p.platform.setServerUrl(null); p.platform.setAuthToken(null); p.platform.setNativeMode('local');
    p.done((await p.rows('ai_chat_history')).map(r => r.content));`);
  await web(A, 'carol', 'DELETE', '/api/ai/history');
  const after = phone('chat-carol', A, `
    // Settings > Server > Connect as carol, Upload Phone to Server.
    const tok = JSON.parse(process.env.PHONE_TOKENS)[p.S].carol;
    p.platform.setAuthToken(tok);
    const me = await (await fetch(p.S + '/api/auth/me', { headers: { Authorization: 'Bearer ' + tok } })).json();
    const same = await p.la.cameFromThisAccount(p.S, me.user);
    const { uploadLocalToServer } = await import(p.SRC + 'lib/migrate.js');
    await uploadLocalToServer({ serverUrl: p.S, authToken: tok, keepIds: same });
    await p.la.claimForServer(p.S, me.user.id, { created: me.user.created_at, sameAccount: same });
    localStorage.setItem('note:cachedUser', JSON.stringify(me.user));
    p.platform.setServerUrl(p.S); p.platform.setNativeMode('server');
    await p.sync(); await p.sync();
    p.done({ same, chat: (await p.rows('ai_chat_history')).map(r => r.content) });`);
  assert.deepEqual(before, ['carol asks before']);
  assert.deepEqual(after, { same: true, chat: [] });
  assert.deepEqual(chatOn(A, 'carol'), [], 'and it never went back up');
});

test('Upload to another account takes the chat once; chat cleared before never goes', async (t) => {
  if (skip(t)) return;
  for (const m of ['alice on b asks 1', 'alice on b asks 2']) await chat(B, 'alice', m);
  phone('chat-move', B, `
    await p.setupSignIn('alice'); await p.sync();
    p.done(null);`);
  await web(B, 'alice', 'DELETE', '/api/ai/history');
  await chat(B, 'alice', 'alice on b keeps');
  const r = phone('chat-move', B, `
    await p.loginSignIn('alice'); await p.sync();
    const left = (await p.rows('ai_chat_history')).map(r => r.content);
    // Disconnect, then Connect to server A as bob with Upload.
    await p.la?.setLocalOwner?.();
    p.platform.setServerUrl(null); p.platform.setAuthToken(null); p.platform.setNativeMode('local');
    const A = ${JSON.stringify(A.base)};
    const tok = JSON.parse(process.env.PHONE_TOKENS)[A].bob;
    p.platform.setAuthToken(tok);
    const me = await (await fetch(A + '/api/auth/me', { headers: { Authorization: 'Bearer ' + tok } })).json();
    const { uploadLocalToServer } = await import(p.SRC + 'lib/migrate.js');
    await uploadLocalToServer({ serverUrl: A, authToken: tok, keepIds: false });
    await p.la.claimForServer(A, me.user.id, { created: me.user.created_at, sameAccount: false });
    localStorage.setItem('note:cachedUser', JSON.stringify(me.user));
    p.platform.setServerUrl(A); p.platform.setNativeMode('server');
    await p.sync(); await p.sync(); await p.sync();
    p.done({ left, waiting: (await p.rows('ai_chat_history')).filter(r => r.sync_status !== 'synced').length });`);
  assert.deepEqual(r, { left: ['alice on b keeps'], waiting: 0 }, 'it went up and nothing is left waiting');
  assert.deepEqual(chatOn(A, 'bob').filter(c => c.startsWith('alice on b')), ['alice on b keeps'], 'once, and none of the cleared chat');
});

test('a phone can send chat the server already has, and new chat, without an error', async (t) => {
  if (skip(t)) return;
  await chat(B, 'carol', 'carol on b');
  const id = B.q(`SELECT c.id FROM ai_chat_history c JOIN users u ON u.id = c.user_id WHERE u.username = 'carol'`)[0].id;
  const res = await web(B, 'carol', 'POST', '/api/sync/push', { tables: { ai_chat_history: [
    { client_id: 1, server_id: id, role: 'user', content: 'carol on b', updated_at: '2030-01-01 00:00:00' },
    { client_id: 2, server_id: null, role: 'assistant', content: 'carol on b answer', updated_at: '2030-01-01 00:00:00' },
  ] } });
  assert.ok(Array.isArray(res.tables.ai_chat_history), JSON.stringify(res.tables.ai_chat_history));
  assert.deepEqual(res.tables.ai_chat_history.map(r => r.client_id), [1, 2]);
  assert.deepEqual(chatOn(B, 'carol'), ['carol on b', 'carol on b answer']);
});

test('Push All after chat was cleared on the web leaves nothing waiting and brings nothing back', async (t) => {
  if (skip(t)) return;
  for (const m of ['carol push all 1', 'carol push all 2']) await chat(B, 'carol', m);
  const r = phone('chat-pushall', B, `
    await p.setupSignIn('carol'); await p.sync();
    const had = (await p.rows('ai_chat_history')).filter(r => r.content.startsWith('carol push all')).length;
    await fetch(p.S + '/api/ai/history', { method: 'DELETE', headers: { Authorization: 'Bearer ' + p.platform.getAuthToken(), 'X-CSRF-Token': 'test' } });
    // Settings > Server > Push All, before the phone heard of the clear.
    await p.syncMod.pushAllFromDevice();
    await p.sync();
    p.done({ had, rows: (await p.rows('ai_chat_history')).map(r => [r.content, r.sync_status]) });`);
  assert.deepEqual(r, { had: 2, rows: [] });
  assert.deepEqual(chatOn(B, 'carol'), [], 'nothing came back');
});

test('a phone sending chat the server has deleted gets an answer, so it stops sending it', async (t) => {
  if (skip(t)) return;
  await chat(B, 'bob', 'bob gone');
  const id = B.q(`SELECT c.id FROM ai_chat_history c JOIN users u ON u.id = c.user_id WHERE c.content = 'bob gone'`)[0].id;
  await web(B, 'bob', 'DELETE', '/api/ai/history');
  const res = await web(B, 'bob', 'POST', '/api/sync/push', { tables: { ai_chat_history: [
    { client_id: 7, server_id: id, role: 'user', content: 'bob gone', updated_at: '2030-01-01 00:00:00' },
  ] } });
  assert.deepEqual(res.tables.ai_chat_history, [{ client_id: 7 }], 'an app before these answers marks it sent');
  const now = await web(B, 'bob', 'POST', '/api/sync/push', { client_now: new Date().toISOString(), tables: { ai_chat_history: [
    { client_id: 8, server_id: id, role: 'user', content: 'bob gone', updated_at: '2030-01-01 00:00:00' },
  ] } });
  assert.deepEqual(now.tables.ai_chat_history, [{ client_id: 8, deleted: true, reason: 'deleted' }], 'this app drops it');
  assert.deepEqual(chatOn(B, 'bob'), [], 'never made again');
});

test('a backup of this account restored after Clear Chat puts the chat back, once', async (t) => {
  if (skip(t)) return;
  for (const m of ['carol restore 1', 'carol restore 2']) await chat(A, 'carol', m);
  const r = phone('chat-restore', A, `
    await p.setupSignIn('carol'); await p.sync();
    const { exportLocalSnapshot, importLocalSnapshot } = await import(p.SRC + 'lib/local-backup.js');
    const snap = JSON.parse(JSON.stringify(await exportLocalSnapshot({ includeImages: false })));
    await fetch(p.S + '/api/ai/history', { method: 'DELETE', headers: { Authorization: 'Bearer ' + p.platform.getAuthToken() } });
    await p.sync();
    const afterClear = (await p.rows('ai_chat_history')).filter(r => r.content.startsWith('carol restore')).length;
    await importLocalSnapshot(snap);
    await p.sync(); await p.sync(); await p.sync();
    p.done({ afterClear, phone: (await p.rows('ai_chat_history')).filter(r => r.content.startsWith('carol restore')).map(r => r.content), waiting: await p.waiting() });`);
  assert.deepEqual(r, { afterClear: 0, phone: ['carol restore 1', 'carol restore 2'], waiting: 0 });
  assert.deepEqual(chatOn(A, 'carol').filter(c => c.startsWith('carol restore')), ['carol restore 1', 'carol restore 2'], 'back on the server, once each');
});

test("every pull lists the account's chat as it is now, and only that account's", async (t) => {
  if (skip(t)) return;
  await chat(B, 'bob', 'bob on b');
  const id = B.q(`SELECT c.id FROM ai_chat_history c JOIN users u ON u.id = c.user_id WHERE c.content = 'bob on b'`)[0].id;
  const cursor = (await web(B, 'bob', 'GET', '/api/sync/pull')).now;
  const since = `?since=${encodeURIComponent(cursor)}`;
  assert.deepEqual((await web(B, 'bob', 'GET', '/api/sync/pull' + since)).chat_ids, [id]);
  assert.ok(!(await web(B, 'carol', 'GET', '/api/sync/pull' + since)).chat_ids.includes(id), "not in another account's");
  await web(B, 'bob', 'DELETE', '/api/ai/history');
  assert.deepEqual((await web(B, 'bob', 'GET', '/api/sync/pull' + since)).chat_ids, []);
});
