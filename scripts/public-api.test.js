/**
 * The public API (TraceApps/notetrace#42), against the real server on a
 * scratch database: a token with notes:create adds notes and tasks and can
 * do nothing else; Idempotency-Key makes a retry safe; a refused request
 * leaves nothing behind; every user makes their own notes:create tokens.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(new URL('../server/package.json', import.meta.url));
let Database = null;
try { Database = require('better-sqlite3'); } catch { /* server packages missing: these cases skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

let srv = null;
test.after(() => { srv?.proc.kill(); });

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'notetrace-api-'));
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'notetrace.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'api-test-0123456789abcdef0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'warn', API_RATE_LIMIT_PER_MIN: '1000', MCP_ENABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const s = { proc, dir, port, log: '' };
  proc.stdout.on('data', (d) => { s.log += d; });
  proc.stderr.on('data', (d) => { s.log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok) return s; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

function ask({ method = 'GET', path, headers = {}, body } = {}) {
  const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path, headers: { ...(data != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

let owner, create, mcp;
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const post = (token, body, extra = {}) => ask({ method: 'POST', path: '/api/v1/notes', headers: { ...bearer(token), ...extra }, body });
const sql = (fn) => { const db = new Database(join(srv.dir, 'notetrace.db')); try { return fn(db); } finally { db.close(); } };
const noteCount = () => sql((db) => db.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL').get().n);
const labelNames = () => sql((db) => db.prepare('SELECT name FROM labels WHERE deleted_at IS NULL ORDER BY name').all().map((r) => r.name));
async function signIn(username, password) {
  const cookie = String((await ask({ method: 'POST', path: '/api/auth/login', body: { username, password } })).headers['set-cookie']?.[0] || '').split(';')[0];
  const me = await ask({ path: '/api/auth/me', headers: { cookie } });
  return { cookie, ...(me.json?.csrf ? { 'x-csrf-token': me.json.csrf } : {}) };
}

test('setup: an admin and two tokens', { skip: !Database && 'needs better-sqlite3' }, async () => {
  srv = await start();
  const reg = await ask({ method: 'POST', path: '/api/auth/register', body: { username: 'owner', password: 'Owner-pass-2026!' } });
  assert.ok(reg.status === 200 || reg.status === 201, srv.log);
  const cookie = String(reg.headers['set-cookie']?.[0] || '').split(';')[0];
  const me = await ask({ path: '/api/auth/me', headers: { cookie } });
  owner = { cookie, ...(me.json?.csrf ? { 'x-csrf-token': me.json.csrf } : {}) };
  // Retry answers for the prune check at the end: the boot-time scheduler
  // tick (5 s after start) must remove the stale one and keep the fresh one.
  sql((db) => {
    const ins = db.prepare(`INSERT INTO api_idempotency (user_id, key, body_hash, status, response, created_at) VALUES (1, ?, 'h', 201, '{}', datetime('now', ?))`);
    ins.run('prune-stale', '-25 hours');
    ins.run('prune-fresh', '-23 hours');
  });
  const make = async (scopes) => (await ask({ method: 'POST', path: '/api/admin/api-tokens', headers: owner, body: { name: scopes.join('+'), scopes, password: 'Owner-pass-2026!' } })).json.raw;
  create = await make(['notes:create']);
  mcp = await make(['mcp:read', 'mcp:write']);
  assert.match(create, /^note_pat_/);
  const list = await ask({ path: '/api/admin/api-tokens', headers: owner });
  assert.ok(list.json.known_scopes.includes('notes:create') && list.json.known_scopes.includes('mcp:write'));
  assert.match(list.json.scope_descriptions['notes:create'], /add notes and tasks/);
  assert.equal(list.json.mcp_state.enabled, true);
});

test('every user makes, sees and revokes only their own tokens, and only admins give MCP scopes', { skip: !Database && 'needs better-sqlite3' }, async () => {
  assert.equal((await ask({ method: 'POST', path: '/api/auth/register', headers: owner, body: { username: 'member', password: 'Member-pass-2026!' } })).status, 200);
  const member = await signIn('member', 'Member-pass-2026!');
  const tokens = (h) => ask({ path: '/api/admin/api-tokens', headers: h });

  const offer = (await tokens(member)).json;
  assert.deepEqual(offer.known_scopes, ['notes:create']);
  assert.deepEqual(Object.keys(offer.scope_descriptions), ['notes:create']);
  assert.equal(offer.mcp_state, undefined);
  assert.deepEqual(offer.tokens, []);

  for (const scopes of [['mcp:read'], ['notes:create', 'mcp:write'], ['mcp:destroy']]) {
    const r = await ask({ method: 'POST', path: '/api/admin/api-tokens', headers: member, body: { name: 'x', scopes, password: 'Member-pass-2026!' } });
    assert.equal(r.status, 403, JSON.stringify(scopes));
  }
  const made = await ask({ method: 'POST', path: '/api/admin/api-tokens', headers: member, body: { name: 'Mail', scopes: ['notes:create'], password: 'Member-pass-2026!' } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.token.scopes, ['notes:create']);

  // The member's token adds to the member's notes, not the admin's.
  const n = await post(made.json.raw, { title: 'Member note' });
  assert.equal(n.status, 201);
  assert.equal(sql((db) => db.prepare('SELECT u.username FROM notes n JOIN users u ON u.id = n.user_id WHERE n.id = ?').get(n.json.note.id).username), 'member');
  assert.equal((await ask({ path: '/api/v1/me', headers: bearer(made.json.raw) })).json.user.username, 'member');

  // Each sees only their own, and can't revoke the other's.
  const mine = (await tokens(member)).json.tokens;
  const theirs = (await tokens(owner)).json.tokens;
  assert.deepEqual(mine.map((t) => t.name), ['Mail']);
  assert.ok(!theirs.some((t) => t.id === made.json.token.id));
  assert.equal((await ask({ method: 'DELETE', path: `/api/admin/api-tokens/${theirs[0].id}`, headers: member })).status, 404);
  assert.equal((await ask({ method: 'DELETE', path: `/api/admin/api-tokens/${made.json.token.id}`, headers: owner })).status, 404);
  assert.equal((await tokens(owner)).json.tokens.length, theirs.length);

  // Revoked, it stops working at once.
  assert.equal((await ask({ method: 'DELETE', path: `/api/admin/api-tokens/${made.json.token.id}`, headers: member })).status, 200);
  assert.equal((await post(made.json.raw, { title: 'after revoke' })).status, 401);
  assert.deepEqual((await tokens(member)).json.tokens, []);
});

test('token expiry is a real time to come or the token is refused', { skip: !Database && 'needs better-sqlite3' }, async () => {
  const make = (expires_at) => ask({ method: 'POST', path: '/api/admin/api-tokens', headers: owner, body: { name: 'exp', scopes: ['notes:create'], expires_at, password: 'Owner-pass-2026!' } });
  // A time gone by, or more than ten years out, is refused too (from TraceApps/nutritrace#222).
  for (const bad of ['garbage', '2020-01-01T00:00:00Z', '2099-02-30 00:00:00', '2099-01-01', 5, '2020-01-01 00:00:00', '2099-01-01 00:00:00']) {
    const r = await make(bad);
    assert.equal(r.status, 400, String(bad));
    assert.match(r.json.error, /[Ee]xpir/);
  }
  // One that expires anyway (an older server kept it): refused.
  const past = await make(new Date(Date.now() + 864e5).toISOString().slice(0, 19).replace('T', ' '));
  assert.equal(past.status, 201);
  sql((db) => db.prepare(`UPDATE api_tokens SET expires_at = '2020-01-01 00:00:00' WHERE id = ?`).run(past.json.token.id));
  assert.equal((await post(past.json.raw, { title: 'x' })).status, 401);
  const future = await make(new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 19).replace('T', ' '));
  assert.equal((await post(future.json.raw, { title: 'x' })).status, 201);
  // A stored value that can't be read (an older server kept anything) counts as expired.
  sql((db) => db.prepare(`UPDATE api_tokens SET expires_at = 'garbage' WHERE id = ?`).run(future.json.token.id));
  assert.equal((await post(future.json.raw, { title: 'x' })).status, 401);
  assert.equal((await make(null)).status, 201);
});

test('GET /api/v1/me says whose token it is, its scopes and the version', { skip: !Database && 'needs better-sqlite3' }, async () => {
  const r = await ask({ path: '/api/v1/me', headers: bearer(create) });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.username, 'owner');
  assert.deepEqual(r.json.scopes, ['notes:create']);
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(r.json.instance.version, version);
  assert.ok(r.headers['x-ratelimit-limit'] && r.headers['x-ratelimit-remaining'] && r.headers['x-ratelimit-reset']);
  assert.equal((await ask({ path: '/api/v1/me' })).status, 401);
  assert.equal((await ask({ path: '/api/v1/me', headers: bearer('note_pat_nope') })).json.code, 'auth_invalid');
  assert.equal((await ask({ path: '/api/v1/nope', headers: bearer(create) })).json.code, 'not_found');
});

test('a note, with labels, a color and where it came from', { skip: !Database && 'needs better-sqlite3' }, async () => {
  const r = await post(create, { title: 'Invoice from Acme', text: 'Pay by **Nov 10**.', labels: ['Mail', '#mail', 'Bills'], color: 'amber', pinned: true, source_url: 'https://mail.example/?m=a(1) b', source_title: 'Invoice [Acme]' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const n = r.json.note;
  assert.equal(n.title, 'Invoice from Acme');
  assert.equal(n.text, 'Pay by **Nov 10**.\n\n[Invoice \\[Acme\\]](https://mail.example/?m=a%281%29%20b)');
  assert.deepEqual(n.labels.sort(), ['Bills', 'Mail']);
  assert.equal(n.color, 'amber');
  assert.equal(n.pinned, true);
  // It's a real note: the owner sees it in the app.
  const mine = await ask({ path: '/api/notes', headers: owner });
  assert.ok(mine.json.some((x) => x.id === n.id));
  // Without a title for the link, the address's host names it.
  const plain = await post(create, { text: 'x', source_url: 'https://mail.example/m/9' });
  assert.equal(plain.json.note.text, 'x\n\n[mail.example](https://mail.example/m/9)');
});

test('labels are cleaned the way the app cleans them, and match the ones that exist', { skip: !Database && 'needs better-sqlite3' }, async () => {
  assert.equal((await post(create, { title: 'a', labels: ['Work'] })).status, 201);
  const work = await post(create, { title: 'b', labels: ['# Work', ' work '] });
  assert.equal(work.status, 201, JSON.stringify(work.json));
  assert.deepEqual(work.json.note.labels, ['Work']);
  const foo = await post(create, { title: 'c', labels: ['foo', '# foo', '#FOO'] });
  assert.equal(foo.status, 201, JSON.stringify(foo.json));
  assert.deepEqual(foo.json.note.labels, ['foo']);
  // A name cut at 60 characters that ends in a space works every time.
  const long = `${'x'.repeat(59)} tail`;
  for (let i = 0; i < 2; i++) {
    const r = await post(create, { title: `long ${i}`, labels: [long] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.deepEqual(r.json.note.labels, ['x'.repeat(59)]);
  }
  assert.equal(labelNames().filter((n) => /^(work|foo|x+)$/i.test(n)).length, 3);
});

test('a note that fails to save takes its new labels with it', { skip: !Database && 'needs better-sqlite3' }, async () => {
  const before = labelNames();
  const notesBefore = noteCount();
  sql((db) => db.exec(`CREATE TRIGGER api_test_fail BEFORE INSERT ON notes WHEN NEW.title = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`));
  try {
    const r = await post(create, { title: 'boom', labels: ['Brand New', 'Work'] }, { 'idempotency-key': 'boom-1' });
    assert.equal(r.status, 500);
  } finally {
    sql((db) => db.exec('DROP TRIGGER api_test_fail'));
  }
  assert.deepEqual(labelNames(), before);
  assert.equal(noteCount(), notesBefore);
  // Nothing was remembered for the key either: the retry goes through.
  const retry = await post(create, { title: 'boom', labels: ['Brand New', 'Work'] }, { 'idempotency-key': 'boom-1' });
  assert.equal(retry.status, 201);
  assert.ok(labelNames().includes('Brand New'));
});

test('a task: a checklist with due dates, shown in Tasks, with a reminder', { skip: !Database && 'needs better-sqlite3' }, async () => {
  const r = await post(create, { title: 'From email', kind: 'checklist', items: [{ text: 'Pay invoice', due: '2099-11-10' }, 'File it'], due: '2099-11-12', show_in_tasks: true, reminder: { at: '2099-11-10T09:00', time_zone: 'America/New_York' }, source_url: 'https://mail.example/m/1' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const n = r.json.note;
  assert.equal(n.kind, 'checklist');
  assert.deepEqual(n.items.map((i) => [i.text, i.due, i.checked]), [['Pay invoice https://mail.example/m/1', '2099-11-10', false], ['File it', '2099-11-12', false]]);
  assert.equal(n.show_in_tasks, true);
  assert.match(JSON.stringify(n.reminder), /2099-11-10/);
  const row = new Database(join(srv.dir, 'notetrace.db'), { readonly: true }).prepare('SELECT reminder_at, reminder_tz FROM notes WHERE id = ?').get(n.id);
  assert.deepEqual(row, { reminder_at: '2099-11-10 14:00:00', reminder_tz: 'America/New_York' });
});

test('a refused request says why and leaves nothing behind, new labels included', { skip: !Database && 'needs better-sqlite3' }, async () => {
  const before = noteCount();
  const labelsBefore = (await ask({ path: '/api/labels', headers: owner })).json.length;
  const cases = [
    [{ kind: 'checklist', items: [{ text: 'x', due: '2099-02-30' }], labels: ['New One'] }, 'items[0].due'],
    [{ text: 'x', reminder: { at: '2020-01-01T09:00' } }, 'reminder.at'],
    [{ text: 'x', reminder: { at: '2099-01-01T09:00', time_zone: 'Mars/Base' } }, 'reminder.time_zone'],
    [{ text: 'x', reminder: { at: '2099-02-30T09:00' } }, 'reminder.at'],
    [{ text: 'x', reminder: { at: '2099-13-45' } }, 'reminder.at'],
    [{ text: 'x', reminder: { at: '2099-01-01T99:99' } }, 'reminder.at'],
    [{ text: 'x', reminder: { at: '+099999-01-01T00:00:00Z' } }, 'reminder.at'],
    [{ text: 'x', source_url: 'javascript:alert(1)' }, 'source_url'],
    [{ text: 'x', color: 'neon' }, 'color'],
    [{ kind: 'text', items: ['a'] }, 'items'],
    [{ kind: 'checklist', items: [] }, 'items'],
    [{ title: 5 }, 'title'],
    [{}, undefined],
    [[{ text: 'a' }], undefined],
  ];
  for (const [body, field] of cases) {
    const r = await post(create, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, 'invalid');
    assert.equal(r.json.field, field, JSON.stringify(r.json));
  }
  assert.equal((await post(create, '{not json')).status, 400);
  assert.equal(noteCount(), before);
  assert.equal((await ask({ path: '/api/labels', headers: owner })).json.length, labelsBefore);
});

test('Idempotency-Key: a retry answers the same, a reused key with another body is refused, and keys last a day', { skip: !Database && 'needs better-sqlite3' }, async () => {
  const before = noteCount();
  const body = { title: 'Once', text: 'only once' };
  const a = await post(create, body, { 'idempotency-key': 'mail-42:task-1' });
  const b = await post(create, body, { 'idempotency-key': 'mail-42:task-1' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(b.json.note.id, a.json.note.id);
  assert.equal(b.headers['idempotent-replayed'], 'true');
  assert.equal(noteCount(), before + 1);
  const c = await post(create, { ...body, text: 'changed' }, { 'idempotency-key': 'mail-42:task-1' });
  assert.equal(c.status, 409);
  assert.equal(c.json.code, 'idempotency_conflict');
  assert.equal((await post(create, body, { 'idempotency-key': 'has space' })).json.code, 'bad_idempotency_key');
  // A refused body isn't remembered: the same key works once it's fixed.
  assert.equal((await post(create, { color: 'neon' }, { 'idempotency-key': 'fix-me' })).status, 400);
  assert.equal((await post(create, { text: 'fixed' }, { 'idempotency-key': 'fix-me' })).status, 201);
  // The same body with its keys in another order is the same body.
  const reordered = await post(create, { text: 'only once', title: 'Once' }, { 'idempotency-key': 'mail-42:task-1' });
  assert.equal(reordered.status, 201);
  assert.equal(reordered.json.note.id, a.json.note.id);
  const nested = { kind: 'checklist', items: [{ text: 'a', due: '2099-01-02' }], reminder: { at: '2099-01-01T09:00', time_zone: 'UTC' } };
  const n1 = await post(create, nested, { 'idempotency-key': 'nested' });
  const n2 = await post(create, { reminder: { time_zone: 'UTC', at: '2099-01-01T09:00' }, items: [{ due: '2099-01-02', text: 'a' }], kind: 'checklist' }, { 'idempotency-key': 'nested' });
  assert.equal(n2.json.note.id, n1.json.note.id);
  // A retry within the day never adds a second note, even after the first was deleted.
  assert.equal((await ask({ method: 'DELETE', path: `/api/notes/${n1.json.note.id}`, headers: owner })).status, 200);
  const afterDelete = await post(create, nested, { 'idempotency-key': 'nested' });
  assert.equal(afterDelete.json.note.id, n1.json.note.id);
  assert.equal(afterDelete.headers['idempotent-replayed'], 'true');
  // Without a key every request adds a note.
  await post(create, body); await post(create, body);
  assert.equal(noteCount(), before + 5); // nested is in the Trash, still a note
  // Past a day the key is free again.
  const db = new Database(join(srv.dir, 'notetrace.db'));
  db.prepare(`UPDATE api_idempotency SET created_at = datetime('now', '-25 hours') WHERE key = 'mail-42:task-1'`).run();
  db.close();
  const d = await post(create, body, { 'idempotency-key': 'mail-42:task-1' });
  assert.equal(d.status, 201);
  assert.notEqual(d.json.note.id, a.json.note.id);
});

test('a notes:create token can only add notes; an MCP token can\'t add through it', { skip: !Database && 'needs better-sqlite3' }, async () => {
  for (const [method, path] of [['GET', '/api/notes'], ['GET', '/api/labels'], ['PATCH', '/api/notes/1'], ['DELETE', '/api/notes/1'], ['GET', '/api/admin/api-tokens'], ['POST', '/api/admin/api-tokens']]) {
    const r = await ask({ method, path, headers: bearer(create), body: method === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, `${method} ${path}`);
  }
  // MCP is on in this server, so this is the scope check refusing, not a missing route.
  const m = await ask({ method: 'POST', path: '/api/mcp', headers: { ...bearer(create), accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(m.status, 403);
  assert.equal(m.json.code, 'auth_scope');
  const ok = await ask({ method: 'POST', path: '/api/mcp', headers: { ...bearer(mcp), accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } } });
  assert.equal(ok.status, 200);
  const r = await post(mcp, { text: 'x' });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'auth_scope');
});

test('a page on another site can\'t use the API through someone\'s browser', { skip: !Database && 'needs better-sqlite3' }, async () => {
  const r = await post(create, { text: 'from a page' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'cross_site');
});

test('the scheduler drops retry answers older than a day and keeps newer ones', { skip: !Database && 'needs better-sqlite3' }, async () => {
  const keys = () => sql((db) => db.prepare(`SELECT key FROM api_idempotency WHERE key LIKE 'prune-%' ORDER BY key`).all().map((r) => r.key));
  for (let i = 0; i < 150 && keys().includes('prune-stale'); i++) await sleep(100);
  assert.deepEqual(keys(), ['prune-fresh']);
});

test('wiring: the scope, the mount, CSRF and the daily prune', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../server/lib/api-tokens.js'), /'notes:create',\n\]\);/);
  assert.match(read('../server/index.js'), /router\.use\('\/api\/v1',\s+apiV1Routes\)/);
  assert.match(read('../server/middleware/csrf.js'), /BEARER_ONLY = \['\/api\/mcp', '\/api\/v1'\]/);
  assert.match(read('../server/lib/scheduler.js'), /DELETE FROM api_idempotency WHERE created_at <= datetime\('now', '-1 day'\)/);
});
