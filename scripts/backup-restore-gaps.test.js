/**
 * What a full backup restore brings back, and what devices learn of it,
 * against the real server on a scratch database:
 *
 * - Devices drop what the restore took away: notes, labels, list items,
 *   attachments and label links made after the backup are sent as deleted,
 *   and a note shared after the backup leaves the device it was shared to.
 * - A backup from 1.1 (before Read Only, a column that can't be empty)
 *   brings back every note.
 * - A table the backup holds no rows of is emptied too (an invite made
 *   after the backup doesn't stay).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }
const skip = !ready && 'server packages missing';

const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
const JWT_SECRET = 'restore-gaps-test-0123456789abcdef01234567';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));

function server() {
  const s = { tok: {}, ids: {} };
  s.dir = mkdtempSync(join(tmpdir(), 'note-restore-gaps-'));
  s.env = () => ({ ...cleanEnv(), DB_PATH: join(s.dir, 'notes.db'), UPLOADS_PATH: join(s.dir, 'uploads'), BACKUPS_PATH: join(s.dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' });
  s.boot = async () => {
    const port = await freePort();
    s.base = `http://127.0.0.1:${port}`;
    s.proc = spawn(process.execPath, ['index.js'], { cwd: serverDir, env: { ...s.env(), PORT: String(port) }, stdio: ['ignore', 'ignore', process.env.SRV_LOG ? 'inherit' : 'ignore'] });
    for (let i = 0; i < 300; i++) {
      try { if ((await fetch(s.base + '/api/auth/status')).ok) return; } catch { /* not up yet */ }
      await sleep(100);
    }
    throw new Error('server did not start');
  };
  s.stop = async () => { const p = s.proc; s.proc = null; if (p && p.exitCode == null && p.signalCode == null) await new Promise((r) => { p.once('exit', r); p.kill(); }); };
  s.call = async (who, method, path, body) => {
    const h = { 'Content-Type': 'application/json' };
    if (who) h.Authorization = `Bearer ${s.tok[who]}`;
    const r = await fetch(s.base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  };
  s.ok = async (...a) => { const r = await s.call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
  s.db = () => new (serverRequire('better-sqlite3'))(join(s.dir, 'notes.db'));
  s.sql = (fn) => { const d = s.db(); try { return fn(d); } finally { d.close(); } };
  s.sign = (id, username, role) => serverRequire('jsonwebtoken').sign({ id, username, role }, JWT_SECRET, { expiresIn: '1h' });
  s.setup = async () => {
    await s.boot();
    await s.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW, full_name: 'Ada Admin' });
    s.tok.admin = (await s.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
    for (const name of ['writer', 'reader']) {
      const u = (await s.ok('admin', 'POST', '/api/auth/register', { username: name, password: PW, full_name: name, role: 'user' })).user;
      s.ids[name] = u.id;
      s.tok[name] = s.sign(u.id, name, u.role);
    }
  };
  s.backup = async () => (await s.ok('admin', 'POST', '/api/full-backup')).filename;
  s.restore = async (filename) => s.ok('admin', 'POST', `/api/full-backup/${encodeURIComponent(filename)}/restore`);
  // A backup file, its database.json changed by `edit`, restored by upload.
  s.uploadRestore = async (zipPath, edit = () => {}) => {
    const AdmZip = serverRequire('adm-zip');
    const zip = new AdmZip(zipPath);
    const data = JSON.parse(zip.readAsText('database.json'));
    edit(data);
    zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
    const form = new FormData();
    form.append('backup', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'backup.zip');
    const r = await fetch(s.base + '/api/full-backup/upload-restore', { method: 'POST', headers: { Authorization: `Bearer ${s.tok.admin}` }, body: form });
    assert.ok(r.ok, await r.text());
  };
  s.close = async () => { await s.stop(); rmSync(s.dir, { recursive: true, force: true }); };
  return s;
}


let S;
test.before(async () => {
  if (!ready) return;
  S = server();
  await S.setup();
});
test.after(async () => { await S?.close(); });

const pull = async (who, since) => S.ok(who, 'GET', `/api/sync/pull?ro=1${since ? `&since=${encodeURIComponent(since)}` : ''}`);

test('devices drop every row the restore took away', { skip }, async () => {
  const { writer, reader } = S.ids;
  const kept = S.sql((d) => d.prepare(`INSERT INTO notes (user_id, title) VALUES (?, 'Kept')`).run(writer).lastInsertRowid);
  const filename = await S.backup();
  const made = S.sql((d) => {
    const ins = (sql, ...a) => d.prepare(sql).run(...a).lastInsertRowid;
    const note = ins(`INSERT INTO notes (user_id, title, kind, share_token) VALUES (?, 'After', 'checklist', 'public-after-0123456789')`, writer);
    const label = ins(`INSERT INTO labels (user_id, name) VALUES (?, 'After Label')`, writer);
    return {
      notes: note,
      labels: label,
      checklist_items: ins(`INSERT INTO checklist_items (uuid, user_id, note_id, text) VALUES ('ci-after', ?, ?, 'milk')`, writer, note),
      note_attachments: ins(`INSERT INTO note_attachments (uuid, user_id, note_id, url) VALUES ('at-after', ?, ?, '/uploads/x.png')`, writer, kept),
      note_labels: ins(`INSERT INTO note_labels (user_id, note_id, label_id) VALUES (?, ?, ?)`, writer, kept, label),
      member: ins(`INSERT INTO note_members (note_id, user_id, role, added_by) VALUES (?, ?, 'edit', ?)`, note, reader, writer),
    };
  });
  const cursor = (await pull('writer')).now;
  const readerCursor = (await pull('reader')).now;
  assert.ok((await pull('reader')).tables.notes.some((n) => n.id === made.notes), 'shared with the reader');
  await sleep(50);
  await S.restore(filename);
  const p = await pull('writer', cursor);
  for (const t of ['notes', 'labels', 'checklist_items', 'note_attachments', 'note_labels']) {
    const rows = (p.tables[t] || []).filter((r) => r.id === made[t]);
    assert.ok(rows.length && rows.every((r) => r.deleted_at), `${t}: the row made after the backup is sent as deleted`);
    assert.equal(S.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE id = ? AND deleted_at IS NULL`).get(made[t]).n), 0, `${t}: not alive on the server`);
  }
  assert.ok(p.tables.notes.some((n) => n.id === kept && !n.deleted_at), 'the kept note is sent again');
  assert.ok((await pull('reader', readerCursor)).revoked_notes.includes(made.notes), 'the note shared after the backup leaves the reader\'s devices');
  assert.equal(S.sql((d) => d.prepare('SELECT share_token FROM notes WHERE id = ?').get(made.notes).share_token), null, 'its public link no longer opens it');
});

test('a backup from 1.1 brings back every note', { skip }, async () => {
  const u = S.ids.writer;
  S.sql((d) => {
    const n = d.prepare(`INSERT INTO notes (user_id, title, kind) VALUES (?, 'Old List', 'checklist')`).run(u).lastInsertRowid;
    d.prepare(`INSERT INTO checklist_items (uuid, user_id, note_id, text) VALUES ('ci-old', ?, ?, 'eggs')`).run(u, n);
  });
  const count = () => S.sql((d) => ['notes', 'checklist_items'].map((t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE deleted_at IS NULL`).get().n));
  const before = count();
  const filename = await S.backup();
  await S.uploadRestore(join(S.dir, 'backups', filename), (data) => { for (const n of data.notes) delete n.read_only; });
  assert.deepEqual(count(), before);
  assert.equal(S.sql((d) => d.prepare(`SELECT read_only FROM notes WHERE title = 'Old List'`).get()?.read_only), 0);
});

test('a table the backup holds nothing of is emptied by the restore', { skip }, async () => {
  const filename = await S.backup();
  S.sql((d) => d.prepare(`INSERT INTO invite_tokens (token, email, role, created_by, expires_at) VALUES ('inv-after', 'x@example.com', 'user', ?, datetime('now', '+7 days'))`).run(S.ids.writer));
  await S.restore(filename);
  assert.equal(S.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM invite_tokens WHERE token = 'inv-after'`).get().n), 0);
});

test('a note made after the backup and edited offline before the restore stays deleted', { skip }, async () => {
  const filename = await S.backup();
  const id = S.sql((d) => d.prepare(`INSERT INTO notes (user_id, title) VALUES (?, 'Offline Note')`).run(S.ids.writer).lastInsertRowid);
  const row = (await pull('writer')).tables.notes.find((n) => n.id === id);
  const editedAt = new Date().toISOString().replace('T', ' ').replace('Z', '');
  await sleep(50);
  await S.restore(filename);
  await S.ok('writer', 'POST', '/api/sync/push', { tables: { notes: [{ ...row, server_id: id, client_id: 99, title: 'Offline Note 2', updated_at: editedAt }] }, client_now: new Date().toISOString() });
  assert.ok(S.sql((d) => d.prepare('SELECT deleted_at FROM notes WHERE id = ?').get(id)?.deleted_at), 'the restore is newer than the edit');
  assert.equal(S.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM notes WHERE title LIKE 'Offline Note%' AND deleted_at IS NULL`).get().n), 0);
});

test('a share removed before the backup and made again since leaves the other person\'s devices', { skip }, async () => {
  const { reader } = S.ids;
  const note = (await S.ok('writer', 'POST', '/api/notes', { title: 'Shared Twice' })).id
    ?? S.sql((d) => d.prepare(`SELECT id FROM notes WHERE title = 'Shared Twice'`).get().id);
  await S.ok('writer', 'POST', `/api/notes/${note}/members`, { username: 'reader' });
  await S.ok('writer', 'DELETE', `/api/notes/${note}/members/${reader}`);
  const filename = await S.backup();
  await S.ok('writer', 'POST', `/api/notes/${note}/members`, { username: 'reader' });
  const cursor = (await pull('reader')).now;
  assert.ok((await pull('reader')).tables.notes.some((n) => n.id === note), 'shared again');
  await sleep(50);
  await S.restore(filename);
  assert.ok((await pull('reader', cursor)).revoked_notes.includes(note), 'the restore takes the share back on the reader\'s devices');
});
