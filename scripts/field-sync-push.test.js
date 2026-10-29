/**
 * Two edits of one row, made on two devices, field by field (lib/field-sync.js).
 *
 * The report: an edit made on one device (a phone offline, the web's offline
 * outbox, a web page open since before) undid a newer edit made elsewhere
 * to a DIFFERENT field of the same row, or was itself dropped because the
 * row had a newer edit of some other field. Sync decided by the newest whole
 * row. Now the newer edit of each field stays, fields that belong together
 * (a note's text and kind, its reminder) stay together, and a delete made
 * before a later edit doesn't win.
 *
 * Real servers (server/index.js on scratch databases), pushes as the
 * Android app and the web's outbox send them.
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

// ── Notes ──────────────────────────────────────────────────────────────

test('notes: a phone edit made after a web rename keeps the new title (the app says it changed the color)', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Groceries', body_md: 'milk' });
  const copy = await phoneCopy(n.id);
  await tick();
  await call('PATCH', `/api/notes/${n.id}`, { title: 'Groceries for Sunday' });
  await tick();
  const r = await push({ notes: [{ ...copy, color: 'sky', updated_at: iso(), changed_fields: ['color'] }] });
  assert.equal(r.tables.notes[0].server_id, n.id);
  const [row] = srv.q('SELECT title, body_md, color FROM notes WHERE id = ?', n.id);
  assert.deepEqual(row, { title: 'Groceries for Sunday', body_md: 'milk', color: 'sky' });
  // The phone gets the row as it is now with its next pull.
  assert.equal((await pull(copy.updated_at)).tables.notes.find(x => x.id === n.id)?.title, 'Groceries for Sunday');
});

test('notes: an offline phone edit made before a web rename still goes in, and the rename stays', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Trip', body_md: 'tent' });
  const copy = await phoneCopy(n.id);
  await tick();
  const madeOffline = iso();
  await tick();
  await call('PATCH', `/api/notes/${n.id}`, { title: 'Trip to the lake' });
  await tick();
  // An app before changed_fields: the whole row, every field counts at its time.
  await push({ notes: [{ ...copy, body_md: 'tent, stove', updated_at: madeOffline }] });
  const [row] = srv.q('SELECT title, body_md FROM notes WHERE id = ?', n.id);
  assert.deepEqual(row, { title: 'Trip to the lake', body_md: 'tent, stove' });
  // The older title the phone sent lost to the rename, and is kept as a version.
  const versions = srv.q(`SELECT title, reason FROM note_versions WHERE note_id = ? ORDER BY id`, n.id);
  assert.ok(versions.some(v => v.reason === 'conflict' && v.title === 'Trip'), JSON.stringify(versions));
});

test("notes: the web's offline outbox (a few fields, made earlier) goes in beside a newer edit of another field", async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Ideas', body_md: 'one' });
  const seen = await call('GET', `/api/notes/${n.id}`);
  await tick();
  // Pinned in a browser with no connection: the outbox's own push (src/lib/offline-edits.js).
  const ops = [{ type: 'update', id: n.id, patch: { pinned: true }, at: Date.now() }];
  const { buildPush, applyOps } = await import('../src/lib/offline-edits.js');
  const body = buildPush(ops, new Map([[n.id, seen]]), applyOps([seen], ops));
  await tick();
  await call('PATCH', `/api/notes/${n.id}`, { body_md: 'one, two' });
  await tick();
  await push(body.tables);
  const [row] = srv.q('SELECT body_md, pinned FROM notes WHERE id = ?', n.id);
  assert.deepEqual(row, { body_md: 'one, two', pinned: 1 });
});

test('notes: a text and its kind go together; a reminder is one', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Plan', body_md: 'a', reminder_at: '2026-12-01 09:00:00', reminder_rrule: 'weekly', reminder_tz: 'UTC' });
  const copy = await phoneCopy(n.id);
  await tick();
  const madeOffline = iso();
  await tick();
  // Here, later: the reminder's repeat.
  await call('PATCH', `/api/notes/${n.id}`, { reminder_rrule: 'daily' });
  await tick();
  // The phone moved the reminder earlier, offline: its whole reminder loses.
  await push({ notes: [{ ...copy, reminder_at: '2026-11-30 08:00:00', updated_at: madeOffline, changed_fields: ['reminder_at'] }] });
  const [row] = srv.q('SELECT reminder_at, reminder_rrule FROM notes WHERE id = ?', n.id);
  assert.deepEqual(row, { reminder_at: '2026-12-01 09:00:00', reminder_rrule: 'daily' });
});

test('notes: a delete made before a later edit elsewhere loses; one made after it wins', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Keep me', body_md: 'x' });
  const copy = await phoneCopy(n.id);
  await tick();
  const deletedOffline = iso();
  await tick();
  await call('PATCH', `/api/notes/${n.id}`, { body_md: 'x, y' });
  await tick();
  const r = await push({ notes: [{ ...copy, updated_at: deletedOffline, deleted_at: deletedOffline }] });
  assert.equal(r.tables.notes[0].server_id, n.id);
  assert.equal(srv.q('SELECT deleted_at FROM notes WHERE id = ?', n.id)[0].deleted_at, null);
  await tick();
  await push({ notes: [{ ...copy, updated_at: iso(), deleted_at: iso() }] });
  assert.notEqual(srv.q('SELECT deleted_at FROM notes WHERE id = ?', n.id)[0].deleted_at, null);
  // An edit made before that delete doesn't bring it back.
  const r2 = await push({ notes: [{ ...copy, body_md: 'z', updated_at: deletedOffline, changed_fields: ['body_md'] }] });
  assert.equal(r2.tables.notes[0].deleted, true);
  assert.notEqual(srv.q('SELECT deleted_at FROM notes WHERE id = ?', n.id)[0].deleted_at, null);
});

// ── Checklist items, pictures, labels, settings ───────────────────────

test('checklist items: ticking an item on the phone keeps the wording changed on the web', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'List', kind: 'checklist', items: [{ uuid: 'fs-item-1', text: 'eggs' }] });
  const item = (await pull()).tables.checklist_items.find(i => i.uuid === 'fs-item-1');
  await tick();
  await call('PATCH', `/api/notes/${n.id}/items/fs-item-1`, { text: 'a dozen eggs' });
  await tick();
  const { id, client_key, ...rest } = item;
  await push({ checklist_items: [{ ...rest, client_id: 7001, server_id: id, checked: 1, checked_at: iso(), updated_at: iso(), changed_fields: ['checked', 'checked_at'] }] });
  const [row] = srv.q('SELECT text, checked FROM checklist_items WHERE uuid = ?', 'fs-item-1');
  assert.deepEqual(row, { text: 'a dozen eggs', checked: 1 });
});

test('checklist items: an older phone edit of another field goes in', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'List 2', kind: 'checklist', items: [{ uuid: 'fs-item-2', text: 'bread' }] });
  const item = (await pull()).tables.checklist_items.find(i => i.uuid === 'fs-item-2');
  await tick();
  const madeOffline = iso();
  await tick();
  await call('PATCH', `/api/notes/${n.id}/items/fs-item-2`, { text: 'rye bread' });
  await tick();
  const { id, client_key, ...rest } = item;
  await push({ checklist_items: [{ ...rest, client_id: 7002, server_id: id, checked: 1, checked_at: madeOffline, updated_at: madeOffline }] });
  const [row] = srv.q('SELECT text, checked FROM checklist_items WHERE uuid = ?', 'fs-item-2');
  assert.deepEqual(row, { text: 'rye bread', checked: 1 });
});

test('pictures: a summary written on the phone keeps the text read on the web', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Receipt' });
  await call('POST', `/api/notes/${n.id}/attachments`, { attachments: [{ uuid: 'fs-att-1', url: '/uploads/x.png', mime: 'image/png' }] });
  const att = (await pull()).tables.note_attachments.find(a => a.uuid === 'fs-att-1');
  await tick();
  await call('PATCH', `/api/notes/${n.id}/attachments/fs-att-1`, { extracted_text: 'Total 12.40' });
  await tick();
  const { id, client_key, ...rest } = att;
  await push({ note_attachments: [{ ...rest, client_id: 7101, server_id: id, summary: 'A receipt', updated_at: iso(), changed_fields: ['summary'] }] });
  const [row] = srv.q('SELECT extracted_text, summary FROM note_attachments WHERE uuid = ?', 'fs-att-1');
  assert.deepEqual(row, { extracted_text: 'Total 12.40', summary: 'A receipt' });
});

test("labels: a color changed on the phone keeps the web's new name", async (t) => {
  if (skip(t)) return;
  const l = await call('POST', '/api/labels', { name: 'Work' });
  const label = (await pull()).tables.labels.find(x => x.id === l.id);
  await tick();
  await call('PATCH', `/api/labels/${l.id}`, { name: 'Office' });
  await tick();
  const { id, client_key, ...rest } = label;
  await push({ labels: [{ ...rest, client_id: 7201, server_id: id, color: 'sky', updated_at: iso(), changed_fields: ['color'] }] });
  const [row] = srv.q('SELECT name, color FROM labels WHERE id = ?', l.id);
  assert.deepEqual(row, { name: 'Office', color: 'sky' });
});

test('settings: a setting changed earlier on the phone does not undo a later change on the web', async (t) => {
  if (skip(t)) return;
  const madeOffline = iso();
  await tick();
  await call('PUT', '/api/settings', { key: 'fs_theme', value: 'dark' });
  await tick();
  await push({}, [{ key: 'fs_theme', value: JSON.stringify('light'), updated_at: madeOffline }]);
  assert.equal(srv.q(`SELECT value FROM user_settings WHERE key = 'fs_theme'`)[0].value, JSON.stringify('dark'));
  // A later one goes in.
  await tick();
  await push({}, [{ key: 'fs_theme', value: JSON.stringify('light'), updated_at: iso() }]);
  assert.equal(srv.q(`SELECT value FROM user_settings WHERE key = 'fs_theme'`)[0].value, JSON.stringify('light'));
});

test("a note's delete made before a later edit of one of its items loses; a label removed before it was put back stays", async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Chores', kind: 'checklist', items: [{ uuid: 'fs-item-3', text: 'dishes' }] });
  const copy = await phoneCopy(n.id);
  await tick();
  const deletedOffline = iso();
  await tick();
  await call('PATCH', `/api/notes/${n.id}/items/fs-item-3`, { checked: true });
  await tick();
  await push({ notes: [{ ...copy, updated_at: deletedOffline, deleted_at: deletedOffline }] });
  assert.equal(srv.q('SELECT deleted_at FROM notes WHERE id = ?', n.id)[0].deleted_at, null, 'note: ' + JSON.stringify(srv.q('SELECT field_times FROM checklist_items WHERE note_id = ?', n.id)));

  const l = await call('POST', '/api/labels', { name: 'Home' });
  await call('PATCH', `/api/notes/${n.id}`, { labels: [l.id] });
  const link = (await pull()).tables.note_labels.find(x => x.note_id === n.id && x.label_id === l.id);
  await tick();
  const removedOffline = iso();
  await tick();
  // Taken off and put back on the web after the phone took it off.
  await call('PATCH', `/api/notes/${n.id}`, { labels: [] });
  await call('PATCH', `/api/notes/${n.id}`, { labels: [l.id] });
  await tick();
  await push({ note_labels: [{ client_id: 7301, server_id: link.id, note_id: n.id, label_id: l.id, updated_at: removedOffline, deleted_at: removedOffline }] });
  assert.equal(srv.q('SELECT deleted_at FROM note_labels WHERE id = ?', link.id)[0].deleted_at, null, 'link: ' + JSON.stringify(srv.q('SELECT field_times FROM note_labels WHERE id = ?', link.id)) + removedOffline);
  // Taken off after it was put back: off.
  await tick();
  await push({ note_labels: [{ client_id: 7301, server_id: link.id, note_id: n.id, label_id: l.id, updated_at: iso(), deleted_at: iso() }] });
  assert.notEqual(srv.q('SELECT deleted_at FROM note_labels WHERE id = ?', link.id)[0].deleted_at, null);
});

test("a shared note: a member's later color keeps the owner's later rename; their older text loses and is kept", async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Shared', body_md: 'v1' });
  await call('POST', `/api/notes/${n.id}/members`, { username: 'bob', role: 'edit' });
  const bobsCopy = (await call('GET', `/api/sync/pull?since=1970-01-01T00:00:00&keys=1&ro=1`, null, {}, srv.bob)).tables.notes.find(x => x.id === n.id);
  const { id, share_role, share_owner, share_count, client_key, ...row } = bobsCopy;
  await tick();
  const bobOffline = iso();
  await tick();
  await call('PATCH', `/api/notes/${n.id}`, { title: 'Shared plan', body_md: 'v2' });
  await tick();
  await pushAs(srv.bob, { notes: [{ ...row, client_id: 7401, server_id: n.id, color: 'sky', body_md: 'bob v1b', updated_at: bobOffline, changed_fields: ['color', 'body_md'] }] });
  const [r] = srv.q('SELECT title, body_md, color FROM notes WHERE id = ?', n.id);
  assert.deepEqual(r, { title: 'Shared plan', body_md: 'v2', color: 'sky' });
  assert.ok(srv.q(`SELECT body_md FROM note_versions WHERE note_id = ? AND reason = 'conflict'`, n.id).some(v => v.body_md === 'bob v1b'));
});

test('a create made offline counts from when it was made', async (t) => {
  if (skip(t)) return;
  const madeOffline = iso(Date.now() - 3600_000);
  const r = await push({ notes: [{ client_id: 7501, title: 'Made offline', body_md: '', kind: 'text', updated_at: madeOffline, deleted_at: null }] });
  const id = r.tables.notes[0].server_id;
  const base = Date.parse(JSON.parse(srv.q('SELECT field_times FROM notes WHERE id = ?', id)[0].field_times)._base);
  assert.ok(Math.abs(base - Date.parse(madeOffline)) < 2000, `${new Date(base).toISOString()} vs ${madeOffline}`);
});

test('rows from before count from their last write, and no device pulls them again for it', async (t) => {
  if (skip(t)) return;
  const b = await startServer('b');
  try {
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` };
    const n = await (await fetch(b.base + '/api/notes', { method: 'POST', headers: H, body: JSON.stringify({ title: 'Old', body_md: 'row' }) })).json();
    b.proc.kill();
    await sleep(500);
    const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
    const d = new Database(join(dir, 'b.db'));
    // As a server before field_times left it.
    d.exec(`DROP TRIGGER IF EXISTS trg_notes_synced_upd`);
    d.prepare(`UPDATE notes SET field_times = NULL, updated_at = '2026-01-02 03:04:05', synced_at = '2026-01-02 03:04:05.000' WHERE id = ?`).run(n.id);
    d.close();
    const again = await startServer('b2', join(dir, 'b.db'));
    try {
      const [row] = again.q('SELECT field_times, synced_at FROM notes WHERE id = ?', n.id);
      // Nothing is written to start the times (rowTimes reads updated_at
      // for every field until the row's first write).
      assert.equal(row.field_times, null);
      assert.equal(row.synced_at, '2026-01-02 03:04:05.000');
      const H2 = { 'Content-Type': 'application/json', Authorization: `Bearer ${again.token}` };
      await fetch(again.base + `/api/notes/${n.id}`, { method: 'PATCH', headers: H2, body: JSON.stringify({ pinned: true }) });
      const after = JSON.parse(again.q('SELECT field_times FROM notes WHERE id = ?', n.id)[0].field_times);
      assert.equal(after._base, '2026-01-02 03:04:05', 'its first write starts them from its last');
      assert.ok(after.pinned);
    } finally { again.proc.kill(); }
  } finally { b.proc.kill(); }
});

// ── The pull never hands an app the times ─────────────────────────────

test('field_times stays on the server: no pull row carries it', async (t) => {
  if (skip(t)) return;
  const all = (await pull()).tables;
  for (const [name, rows] of Object.entries(all)) for (const r of rows) assert.ok(!('field_times' in r), name);
});

// ── Review round: clocks, a delete that took a note's items, the outbox's items ──

test("settings: a phone's fast clock doesn't hold a setting against its own or anyone's later change", async (t) => {
  if (skip(t)) return;
  const fast = 3600_000;
  const pushFast = settings => call('POST', '/api/sync/push', { tables: {}, settings, client_now: iso(Date.now() + fast) });
  await pushFast([{ key: 'fs_fast', value: JSON.stringify('a'), updated_at: iso(Date.now() + fast) }]);
  await tick();
  await pushFast([{ key: 'fs_fast', value: JSON.stringify('b'), updated_at: iso(Date.now() + fast) }]);
  assert.equal(srv.q(`SELECT value FROM user_settings WHERE key = 'fs_fast'`)[0].value, JSON.stringify('b'));
  await tick();
  await push({}, [{ key: 'fs_fast', value: JSON.stringify('c'), updated_at: iso() }]);
  assert.equal(srv.q(`SELECT value FROM user_settings WHERE key = 'fs_fast'`)[0].value, JSON.stringify('c'));
});

test("a note deleted forever on the phone before a later edit of one item keeps all its items, labels and pictures", async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Keep all', kind: 'checklist', items: [{ uuid: 'fs-k-x', text: 'x' }, { uuid: 'fs-k-y', text: 'y' }, { uuid: 'fs-k-z', text: 'z' }] });
  const copy = await phoneCopy(n.id);
  const items = (await pull()).tables.checklist_items.filter(i => i.note_id === n.id);
  await tick();
  const deletedOffline = iso();
  await tick();
  await call('PATCH', `/api/notes/${n.id}/items/fs-k-x`, { text: 'x, edited' });
  await tick();
  // What the app's Delete Forever sends: the note and each item, one time.
  await push({
    notes: [{ ...copy, updated_at: deletedOffline, deleted_at: deletedOffline }],
    checklist_items: items.map((i, k) => { const { id, client_key, ...rest } = i; return { ...rest, client_id: 7400 + k, server_id: id, updated_at: deletedOffline, deleted_at: deletedOffline }; }),
  });
  assert.equal(srv.q('SELECT deleted_at FROM notes WHERE id = ?', n.id)[0].deleted_at, null);
  assert.deepEqual(srv.q('SELECT uuid, deleted_at FROM checklist_items WHERE note_id = ? ORDER BY uuid', n.id),
    [{ uuid: 'fs-k-x', deleted_at: null }, { uuid: 'fs-k-y', deleted_at: null }, { uuid: 'fs-k-z', deleted_at: null }]);
  // One item deleted on its own, at another time, still goes.
  await tick();
  const y = items.find(i => i.uuid === 'fs-k-y');
  const { id: yid, client_key: _ck, ...yrest } = y;
  await push({ checklist_items: [{ ...yrest, client_id: 7499, server_id: yid, updated_at: iso(), deleted_at: iso() }] });
  assert.notEqual(srv.q(`SELECT deleted_at FROM checklist_items WHERE uuid = 'fs-k-y'`)[0].deleted_at, null);
});

test("the web outbox's tick of an item says it changed only the tick, so a rename made elsewhere stays", async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Outbox list', kind: 'checklist', items: [{ uuid: 'fs-o-1', text: 'eggs' }] });
  const seen = await call('GET', `/api/notes/${n.id}`);
  await tick();
  await call('PATCH', `/api/notes/${n.id}/items/fs-o-1`, { text: 'a dozen eggs' });
  await tick();
  const ops = [{ type: 'updateItem', id: n.id, uuid: 'fs-o-1', patch: { checked: true }, at: Date.now() }];
  const { buildPush, applyOps } = await import('../src/lib/offline-edits.js');
  const body = buildPush(ops, new Map([[n.id, seen]]), applyOps([seen], ops));
  const row = body.tables.checklist_items[0];
  assert.ok(row.changed_fields.includes('checked') && !row.changed_fields.includes('text'), JSON.stringify(row.changed_fields));
  await push(body.tables);
  assert.deepEqual(srv.q(`SELECT text, checked FROM checklist_items WHERE uuid = 'fs-o-1'`)[0], { text: 'a dozen eggs', checked: 1 });
});

test("an old app with a fast clock bringing a note back doesn't date the note's return in the future", async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Back', kind: 'checklist', items: [{ uuid: 'fs-f-1', text: 'one' }] });
  const copy = await phoneCopy(n.id);
  const item = (await pull()).tables.checklist_items.find(i => i.uuid === 'fs-f-1');
  await call('DELETE', `/api/notes/${n.id}`).catch(() => {});
  await call('DELETE', `/api/notes/${n.id}/forever`).catch(() => {});
  const ahead = Date.now() + 86400_000;
  const { id: iid, client_key: _ck, ...irest } = item;
  // No client_now: an app from before these answers, its clock a day ahead.
  await call('POST', '/api/sync/push', { tables: { notes: [{ ...copy, updated_at: iso(ahead) }], checklist_items: [{ ...irest, client_id: 7501, server_id: iid, text: 'one, edited', updated_at: iso(ahead) }] } });
  const times = JSON.parse(srv.q('SELECT field_times FROM notes WHERE id = ?', n.id)[0].field_times || '{}');
  for (const [k, v] of Object.entries(times)) assert.ok(Date.parse(v) <= Date.now() + 5000, `${k} ${v}`);
});

test("a title changed offline before a later change of the text keeps its own time (field_edits)", async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Own times', body_md: 'a' });
  const copy = await phoneCopy(n.id);
  await tick();
  const renamedHere = iso();
  await tick();
  await call('PATCH', `/api/notes/${n.id}`, { title: 'Own times (web)' });
  await tick();
  const textHere = iso();
  await push({ notes: [{ ...copy, title: 'Own times (phone)', body_md: 'a, b', updated_at: textHere, changed_fields: ['title', 'body_md'], field_edits: { title: renamedHere, body_md: textHere } }] });
  assert.deepEqual(srv.q('SELECT title, body_md FROM notes WHERE id = ?', n.id)[0], { title: 'Own times (web)', body_md: 'a, b' });
  // The phone's older title is kept as a version.
  assert.ok(srv.q(`SELECT title FROM note_versions WHERE note_id = ? AND reason = 'conflict'`, n.id).some(v => v.title === 'Own times (phone)'));
});

test("the web outbox sends each field with the time it was changed", async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Outbox times', body_md: 'x' });
  const seen = await call('GET', `/api/notes/${n.id}`);
  const t0 = Date.now() - 60_000, t1 = Date.now();
  const ops = [{ type: 'update', id: n.id, patch: { title: 'Renamed offline' }, at: t0 }, { type: 'update', id: n.id, patch: { color: 'sky' }, at: t1 }];
  const { buildPush, applyOps } = await import('../src/lib/offline-edits.js');
  const row = buildPush(ops, new Map([[n.id, seen]]), applyOps([seen], ops)).tables.notes[0];
  assert.deepEqual(Object.keys(row.field_edits).sort(), ['color', 'title']);
  assert.ok(row.field_edits.title < row.field_edits.color, JSON.stringify(row.field_edits));
});

// Closing the editor renamed the [[links]] to the note by sending its title
// again (rename_links_from): a rename made on another device since the
// editor's last save was put back. With links_only the close renames the
// links to the note's title as it now is, and changes no title.
test("closing the editor after a rename elsewhere keeps that rename, and links follow it", async (t) => {
  if (skip(t)) return;
  const linking = await call('POST', '/api/notes', { title: 'Links home', body_md: 'see [[Close A]]' });
  const n = await call('POST', '/api/notes', { title: 'Close A', body_md: 'x' });
  // The editor's autosave renames it (links don't follow yet).
  await call('PATCH', `/api/notes/${n.id}`, { title: 'Close B', rename_links: false });
  await tick();
  // Another device renames it.
  await call('PATCH', `/api/notes/${n.id}`, { title: 'Close C', rename_links: false });
  await tick();
  // The editor closes: links follow the rename from the title it opened with.
  await call('PATCH', `/api/notes/${n.id}`, { title: 'Close B', rename_links_from: 'Close A', links_only: true });
  assert.equal(srv.q('SELECT title FROM notes WHERE id = ?', n.id)[0].title, 'Close C');
  assert.equal(srv.q('SELECT body_md FROM notes WHERE id = ?', linking.id)[0].body_md, 'see [[Close C]]');
  // An app from before (no links_only) renames as it always did.
  await call('PATCH', `/api/notes/${n.id}`, { title: 'Close D', rename_links_from: 'Close C' });
  assert.equal(srv.q('SELECT title FROM notes WHERE id = ?', n.id)[0].title, 'Close D');
  assert.equal(srv.q('SELECT body_md FROM notes WHERE id = ?', linking.id)[0].body_md, 'see [[Close D]]');
});

// Changing a note's labels sent the whole set it showed: a label added on
// another device since was taken off again. With labels_from (the set the
// change was made on) only what that change added or took off changes.
test("a note's labels: a change made on an older set keeps a label added elsewhere since", async (t) => {
  if (skip(t)) return;
  const mk = name => call('POST', '/api/labels', { name });
  const a = await mk('LF one'), b = await mk('LF two'), c = await mk('LF three');
  const n = await call('POST', '/api/notes', { title: 'LF note', body_md: 'x', labels: [a.id] });
  // Another device adds b.
  await call('PATCH', `/api/notes/${n.id}`, { labels: [a.id, b.id] });
  // This one, still showing [a], adds c and takes off a.
  const got = await call('PATCH', `/api/notes/${n.id}`, { labels: [c.id], labels_from: [a.id] });
  assert.deepEqual([...got.labels].sort((x, y) => x - y), [b.id, c.id].sort((x, y) => x - y));
  // An app from before (the whole set) replaces it, as it always did.
  const old = await call('PATCH', `/api/notes/${n.id}`, { labels: [a.id] });
  assert.deepEqual(old.labels, [a.id]);
});

// The watch keeps a tick, or a reminder marked done, made with no
// connection, and sends it later. Sent with no time, it counted as made
// when it arrived, and undid a later change made elsewhere. It now says
// when it was made (edited_at, client_now), which a server from before
// ignores.
test('a tick and a reminder done on the watch offline lose to a later change elsewhere; on time they go in', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'W list', kind: 'checklist', items: [{ uuid: 'w-milk', text: 'milk' }, { uuid: 'w-eggs', text: 'eggs' }] });
  const madeAt = iso();
  await tick();
  // Ticked and unticked again elsewhere, after the watch's tick.
  await call('PATCH', `/api/notes/${n.id}/items/w-milk`, { checked: true });
  await call('PATCH', `/api/notes/${n.id}/items/w-milk`, { checked: false });
  await tick();
  await call('PATCH', `/api/notes/${n.id}/items/w-milk`, { checked: true, edited_at: madeAt, client_now: iso() });
  assert.equal(srv.q(`SELECT checked FROM checklist_items WHERE uuid = 'w-milk'`)[0].checked, 0, 'the later untick stays');
  // Nothing changed it since: the tick goes in.
  await call('PATCH', `/api/notes/${n.id}/items/w-eggs`, { checked: true, edited_at: madeAt, client_now: iso() });
  assert.equal(srv.q(`SELECT checked FROM checklist_items WHERE uuid = 'w-eggs'`)[0].checked, 1);
  // A reminder marked done offline, then set again elsewhere.
  const r = await call('POST', '/api/notes', { title: 'W remind', body_md: 'x', reminder_at: '2026-12-01T09:00:00Z' });
  const doneAt = iso();
  await tick();
  await call('PATCH', `/api/notes/${r.id}`, { reminder_at: '2026-12-02T09:00:00Z' });
  await tick();
  await call('PATCH', `/api/notes/${r.id}`, { reminder_at: null, edited_at: doneAt, client_now: iso() });
  assert.ok(srv.q('SELECT reminder_at FROM notes WHERE id = ?', r.id)[0].reminder_at, 'the new reminder stays');
  // With no time, as before: made now.
  await call('PATCH', `/api/notes/${r.id}`, { reminder_at: null });
  assert.equal(srv.q('SELECT reminder_at FROM notes WHERE id = ?', r.id)[0].reminder_at, null);
});

// A note from before the times counts from its last write (updated_at). A
// tick of one of its items moves its updated_at, without changing any of
// its fields: an offline edit of the note made before the tick, but after
// the note's last real edit, then lost every field. A write that changes
// none of them starts the times first, from the write before.
test('a note from before the times, ticked after an offline edit was made, still takes that edit', async (t) => {
  if (skip(t)) return;
  const b = await startServer('legacytick');
  try {
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` };
    const n = await (await fetch(b.base + '/api/notes', { method: 'POST', headers: H, body: JSON.stringify({ title: 'Old list', kind: 'checklist', items: [{ uuid: 'lt-1', text: 'one' }] }) })).json();
    b.proc.kill();
    await sleep(500);
    const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
    const d = new Database(join(dir, 'legacytick.db'));
    d.prepare(`UPDATE notes SET field_times = NULL, updated_at = '2026-01-02 03:04:05' WHERE id = ?`).run(n.id);
    d.close();
    const again = await startServer('legacytick2', join(dir, 'legacytick.db'));
    try {
      const H2 = { 'Content-Type': 'application/json', Authorization: `Bearer ${again.token}` };
      // Ticked now: the note's updated_at moves.
      await fetch(again.base + `/api/notes/${n.id}/items/lt-1`, { method: 'PATCH', headers: H2, body: JSON.stringify({ checked: true }) });
      // An edit of its title made offline in June, sent now.
      const r = await fetch(again.base + '/api/sync/push', { method: 'POST', headers: H2, body: JSON.stringify({
        client_now: new Date().toISOString(),
        tables: { notes: [{ client_id: 1, server_id: n.id, title: 'Renamed in June', updated_at: '2026-06-01 10:00:00', changed_fields: ['title'] }] },
      }) });
      assert.ok(r.ok);
      assert.equal(again.q('SELECT title FROM notes WHERE id = ?', n.id)[0].title, 'Renamed in June');
    } finally { again.proc.kill(); }
  } finally { b.proc.kill(); }
});

test('a restored backup keeps when each field of a note last changed', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Backed up', body_md: 'x' });
  await tick();
  await call('PATCH', `/api/notes/${n.id}`, { title: 'Backed up, renamed' });
  const before = srv.q('SELECT field_times FROM notes WHERE id = ?', n.id)[0].field_times;
  assert.ok(JSON.parse(before).title);
  const made = await call('POST', '/api/full-backup');
  await call('POST', `/api/full-backup/${encodeURIComponent(made.filename)}/restore`);
  assert.equal(srv.q('SELECT field_times FROM notes WHERE id = ?', n.id)[0].field_times, before);
});

// Sync's bookkeeping (when each field changed) stays on the server: not in
// an export (Settings > Export), nor in any answer about notes.
test('field_times is in no export or answer', async (t) => {
  if (skip(t)) return;
  const n = await call('POST', '/api/notes', { title: 'Out', kind: 'checklist', items: [{ uuid: 'out-1', text: 'a' }] });
  await call('PATCH', `/api/notes/${n.id}`, { title: 'Out, renamed' });
  const label = await call('POST', '/api/labels', { name: 'Out label' });
  await call('PATCH', `/api/notes/${n.id}`, { labels: [label.id] });
  for (const path of ['/api/data/export', `/api/notes/${n.id}`, '/api/notes', '/api/labels', '/api/notes?view=reminders']) {
    const r = await fetch(srv.base + path, { headers: { Authorization: `Bearer ${srv.token}` } });
    assert.ok(!(await r.text()).includes('field_times'), path);
  }
});
