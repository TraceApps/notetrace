/**
 * A change the watch queued and sent later says when it was made (edited_at,
 * client_now), and PATCH /api/notes/:id and /items/:uuid keep the newer
 * edit of each field (lib/field-sync.js). What goes in counts from when it
 * was made, not from when it arrived: a later untick, and a phone's untick
 * made between the two, stay. A watch whose clock is a year or more out
 * counts as made now.
 *
 * Real servers (server/index.js on scratch databases).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const PW = 'Str0ng-Pass-77!x';
let ready = false;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); ready = true; } catch { /* not built for this Node */ }
const skip = t => { if (!ready) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };

const dir = ready ? mkdtempSync(join(tmpdir(), 'note-field-sync-')) : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

let srv = null;
async function startServer(name, dbPath = join(dir, `${name}.db`)) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const secret = `field-sync-${name}-0123456789abcdef`;
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: join(root, 'server'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, UPLOADS_PATH: join(dir, `${name}-uploads`), JWT_SECRET: secret, INSECURE_COOKIES: '1', NODE_ENV: 'test' },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {}
    await sleep(250);
  }
  const reg = await (await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: PW }) })).json();
  if (!reg.user) {
    // A database that already has its accounts.
    const Db = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
    const q = (sql, ...a) => { const d = new Db(dbPath, { readonly: true, fileMustExist: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
    const jwt = createRequire(new URL('../server/package.json', import.meta.url))('jsonwebtoken');
    const alice = q(`SELECT id FROM users WHERE username = 'alice'`)[0];
    const token = alice ? jwt.sign({ id: alice.id, username: 'alice', role: 'admin', csrf: 'test' }, secret, { expiresIn: '1h' }) : null;
    return { base, proc, q, token };
  }
  const jwt = createRequire(new URL('../server/package.json', import.meta.url))('jsonwebtoken');
  const token = jwt.sign({ id: reg.user.id, username: 'alice', role: 'admin', csrf: 'test' }, secret, { expiresIn: '1h' });
  const made = await (await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ username: 'bob', password: PW }) })).json();
  const bob = jwt.sign({ id: made.user.id, username: 'bob', role: 'user', csrf: 'test' }, secret, { expiresIn: '1h' });
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  const q = (sql, ...a) => { const d = new Database(dbPath, { readonly: true, fileMustExist: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
  return { base, proc, token, bob, q };
}

async function call(method, path, body, headers = {}, token = srv.token) {
  const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const push = (tables, settings) => call('POST', '/api/sync/push', { tables, ...(settings ? { settings } : {}), client_now: new Date().toISOString() });
const pushAs = (token, tables) => call('POST', '/api/sync/push', { tables, client_now: new Date().toISOString() }, {}, token);
const pull = (since = '1970-01-01T00:00:00') => call('GET', `/api/sync/pull?since=${encodeURIComponent(since)}&keys=1&ro=1`);
const iso = (ms = Date.now()) => new Date(ms).toISOString();
// A second later than anything before it: times count in whole seconds.
const tick = () => sleep(1100);

// A note as the phone holds it after a pull, sent whole as the app sends it.
async function phoneCopy(id) {
  const n = (await pull()).tables.notes.find(r => r.id === id);
  const { id: _id, share_role, share_owner, share_count, client_key, ...row } = n;
  return { ...row, client_id: 9000 + id, server_id: id };
}

test.before(async () => { if (ready) srv = await startServer('a'); });
test.after(() => { try { srv?.proc.kill(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

// R1: two watch ops queued offline, sent later in order: the later one (untick) must win.
test('a watch\'s tick and later untick, sent in order: unticked', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'R1', kind: 'checklist', items: [{ uuid: 'r1-a', text: 'a' }] });
  await tick();
  const t0 = iso(); await tick(); await tick();
  const t1 = iso(); await tick();
  await call('PATCH', `/api/notes/${n.id}/items/r1-a`, { checked: true, edited_at: t0, client_now: iso() });
  await tick();
  await call('PATCH', `/api/notes/${n.id}/items/r1-a`, { checked: false, edited_at: t1, client_now: iso() });
  const row = srv.q(`SELECT checked, field_times FROM checklist_items WHERE uuid = 'r1-a'`)[0];
  assert.equal(row.checked, 0, 'the watch user last unticked it');
});

// R2: watch tick made T0 arrives at T2; a phone untick made at T1 (T0<T1<T2) pushed after: newer edit is the phone's.
test('a watch tick made before a phone\'s untick, arriving first: the untick stays', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'R2', kind: 'checklist', items: [{ uuid: 'r2-a', text: 'a' }] });
  await tick();
  const t0 = iso(); await tick(); await tick();
  const t1 = iso(); await tick(); await tick();
  await call('PATCH', `/api/notes/${n.id}/items/r2-a`, { checked: true, edited_at: t0, client_now: iso() });
  const item = srv.q(`SELECT * FROM checklist_items WHERE uuid = 'r2-a'`)[0];
  await tick();
  await push({ checklist_items: [{ client_id: 777, server_id: item.id, note_id: n.id, uuid: 'r2-a', text: 'a', checked: 0, checked_at: null, position: item.position, updated_at: t1, changed_fields: ['checked', 'checked_at'] }] });
  const row = srv.q(`SELECT checked, field_times FROM checklist_items WHERE uuid = 'r2-a'`)[0];
  assert.equal(row.checked, 0, 'the phone untick was made after the watch tick');
});

// R3: watch with a clock far off (reset), both edited_at and client_now on it.
test('a watch clock a year or more out: the change counts as made now', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'R3', kind: 'checklist', items: [{ uuid: 'r3-a', text: 'a' }] });
  await tick();
  await call('PATCH', `/api/notes/${n.id}/items/r3-a`, { checked: true, edited_at: '1970-01-01T00:05:00Z', client_now: '1970-01-01T00:06:00Z' });
  const row = srv.q(`SELECT checked FROM checklist_items WHERE uuid = 'r3-a'`)[0];
  assert.equal(row.checked, 1, 'the tick goes in');
});

