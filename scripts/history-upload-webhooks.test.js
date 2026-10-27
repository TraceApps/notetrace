/**
 * Webhooks, push notifications and the Android app's Upload, against the
 * real server (server/index.js on a scratch database and its scheduler), a
 * local receiver that checks each delivery's signature, and a stand-in
 * ntfy server.
 *
 * A phone used without a server keeps its notes on the phone. When it
 * connects to a server, Upload (src/lib/migrate.js) queues every note to
 * go up as new, and the next sync sends them through /api/sync/push, the
 * same route a connected phone's new notes take. Every one of them sent
 * note.created as if written just then, and a reminder that had come due
 * in the last two hours (already shown on the phone) came again from the
 * server, through ntfy, Gotify or Apprise and reminder.fired.
 *
 * Now notes an Upload brings send none, and a reminder of theirs already
 * due doesn't come again; their later reminders still come. The app marks
 * those notes `history_upload` in the push. A connected phone's new notes,
 * and the web's, still send note.created once.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
// Opened, not just required: a binding built for another Node version
// loads only when a database opens.
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const PW = 'Str0ng-Pass-77!x';
const EVENTS = ['note.created', 'checklist.completed', 'reminder.fired'];
let proc = null, base = null, dir = null, receiver = null, hookUrl = null;
const secrets = new Set();
const deliveries = [];
// What reached the mock ntfy server: one title per push.
const pushes = [];

async function call(auth, method, path, body) {
  const h = { 'Content-Type': 'application/json' };
  if (auth) h.Authorization = `Bearer ${auth}`;
  const r = await fetch(base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

// Every delivery `fn` caused, by event. Delivery is fire-and-forget, so
// this waits for the receiver to go quiet.
async function sent(fn) {
  const from = deliveries.length;
  const out = await fn();
  let last = -1;
  for (let i = 0; i < 40 && deliveries.length !== last; i++) { last = deliveries.length; await sleep(150); }
  const got = deliveries.slice(from);
  for (const d of got) assert.ok(d.signed, `${d.event} delivery carries a valid signature`);
  const count = Object.fromEntries(EVENTS.map(e => [e, got.filter(d => d.event === e).length]));
  return { out, got, count, total: got.length };
}

// A new account with a webhook for every event. The first account
// registers itself (and is an admin, as webhooks need); it makes the rest
// as admins.
let n = 0, admin = null;
async function account() {
  const username = `writer${++n}`;
  const reg = await call(admin, 'POST', '/api/auth/register', { username, password: PW, role: 'admin' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const login = await call(null, 'POST', '/api/auth/login', { username, password: PW });
  const token = login.data.token;
  assert.ok(token, JSON.stringify(login.data));
  if (!admin) admin = token;
  const hook = await call(token, 'POST', '/api/admin/webhooks', { url: `${hookUrl}/hook`, events: EVENTS });
  assert.ok(hook.data.secret, JSON.stringify(hook.data));
  secrets.add(hook.data.secret);
  return token;
}

const INSTALL = '7c2e4d10-5a9b-4f3e-8d21-6b0a9c8e7f12';
// db-native.js createKeyOf: this install, the table and the row's id here.
const key = (table, row) => `${INSTALL}:${table}:${row.id}${row.created_at ? `@${row.created_at}` : ''}`;
const iso = (ms) => new Date(Date.now() + ms).toISOString();

// A note as the phone's notes table holds it.
function note(id, extra = {}) {
  return {
    id, server_id: null, user_id: 1, title: `Note ${id}`, body_md: `Body ${id}`, kind: 'text', color: null,
    pinned: 0, archived: 0, in_tasks: 0, read_only: 0, trashed_at: null, reminder_at: null, reminder_rrule: null,
    reminder_tz: null, share_role: 'owner', share_owner: null, share_count: 0,
    created_at: `2026-02-0${Math.min(id, 9)} 10:00:00`, updated_at: `2026-02-0${Math.min(id, 9)} 10:00:00`, deleted_at: null,
    ...extra,
  };
}

// The phone's notes: eight, one a finished checklist, one whose reminder
// came due half an hour ago (the phone showed it), and one whose reminder
// is still to come (in half a minute).
function history() {
  const notes = [];
  for (let i = 1; i <= 8; i++) notes.push(note(i));
  notes[2] = note(3, { kind: 'checklist', title: 'Groceries' });
  notes[3] = note(4, { title: 'Uploaded, already due', reminder_at: iso(-30 * 60000) });
  notes[4] = note(5, { title: 'Uploaded, still to come', reminder_at: iso(30000) });
  const items = [1, 2].map(i => ({ id: i, server_id: null, user_id: 1, uuid: `item-${i}`, note_id: 3, text: `Item ${i}`, checked: 1, position: i,
    due_date: null, due_repeat: null, checked_at: '2026-02-03 11:00:00', created_at: '2026-02-03 10:00:00', updated_at: '2026-02-03 11:00:00', deleted_at: null }));
  return { notes, items };
}

// The app's sync push (src/lib/sync.js pushChanges): every row with its id
// here as client_id, its key, a parent pending in the same push named in
// _local_fks. `marked`: this app marks an Upload's notes history_upload.
function pushRow(table, r, mark) {
  const { id, sync_status, ...row } = r;
  return { ...row, client_id: id, server_id: r.server_id || null, client_key: key(table, r), ...(table === 'checklist_items' ? { _local_fks: ['note_id'] } : {}), ...(mark ? { history_upload: true } : {}) };
}
async function push(token, { notes = [], items = [] }, { marked = false } = {}) {
  const r = await call(token, 'POST', '/api/sync/push', {
    tables: { notes: notes.map(x => pushRow('notes', x, marked)), checklist_items: items.map(x => pushRow('checklist_items', x, false)) },
    settings: [], client_now: new Date().toISOString(),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const t of ['notes', 'checklist_items']) assert.ok(Array.isArray(r.data.tables[t]), JSON.stringify(r.data.tables[t]));
  return r.data;
}

// Upload as the app does it: its settings through the bulk route (ntfy
// among them), then the sync push of every note, marked or not.
async function upload(token, h, { marked = true } = {}) {
  const s = await call(token, 'PUT', '/api/settings/bulk', { settings: { notifPushService: 'ntfy', ntfyUrl: hookUrl, ntfyTopic: 'notetrace-test' } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  return push(token, h, { marked });
}

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'note-history-upload-'));
  const hookPort = await freePort();
  hookUrl = `http://127.0.0.1:${hookPort}`;
  receiver = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url !== '/hook') {
        // The title header is RFC 2047 (=?UTF-8?B?...?=) when it isn't ASCII.
        const t = String(req.headers.title || '');
        const b = t.match(/^=\?UTF-8\?B\?(.*)\?=$/i);
        pushes.push(b ? Buffer.from(b[1], 'base64').toString('utf8') : t);
        res.writeHead(200).end('ok');
        return;
      }
      let env = {};
      try { env = JSON.parse(raw); } catch { /* counted as unsigned below */ }
      const sig = req.headers['x-notetrace-signature'];
      const signed = [...secrets].some(s => sig === `sha256=${createHmac('sha256', s).update(raw).digest('hex')}`);
      deliveries.push({ event: env.event, data: env.data, signed });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => receiver.listen(hookPort, '127.0.0.1', r));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'notetrace.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'history-upload-test-0123456789abcdef0123',
      INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
      WEBHOOKS_ENABLED: '1', ALLOW_PRIVATE_WEBHOOK_URLS: '1', API_RATE_LIMIT_PER_MIN: '1000',
    },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    if (i >= 300) throw new Error('server did not start');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
});

test.after(async () => {
  if (proc) {
    const p = proc; proc = null;
    await new Promise((r) => { if (p.exitCode != null || p.signalCode != null) return r(); p.once('exit', r); p.kill(); });
  }
  if (receiver) await new Promise((r) => receiver.close(r));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const opts = { skip: !ready && 'server packages not installed' };
const none = Object.fromEntries(EVENTS.map(e => [e, 0]));

test('Upload of a phone\'s notes sends no webhooks, and uploading again sends none', opts, async () => {
  const token = await account();
  const h = history();
  // Reminders aside (the next test): none of these has one.
  const plain = { notes: h.notes.filter(x => !x.reminder_at), items: h.items };
  const first = await sent(() => upload(token, plain));
  assert.deepEqual(first.count, none, 'the first Upload');
  const again = await sent(() => upload(token, plain));
  assert.deepEqual(again.count, none, 'the same Upload again');
  // It all went up.
  const list = (await call(token, 'GET', '/api/notes')).data;
  const titles = (Array.isArray(list) ? list : list.notes || []).map(x => x.title);
  for (const x of plain.notes) assert.ok(titles.includes(x.title), x.title);
  // A note written on the phone now, after the Upload, still sends once.
  const next = await sent(() => push(token, { notes: [note(20, { title: 'Written now' })] }));
  assert.deepEqual(next.count, { ...none, 'note.created': 1 });
  // And one written on the web.
  const web = await sent(() => call(token, 'POST', '/api/notes', { title: 'From the web', body_md: 'x' }));
  assert.ok(web.out.status < 300, JSON.stringify(web.out.data));
  assert.deepEqual(web.count, { ...none, 'note.created': 1 });
});

test('an uploaded reminder already due doesn\'t come again; its next one, and one written now, still come', { ...opts, timeout: 240000 }, async () => {
  const token = await account();
  const h = history();
  const first = await sent(() => upload(token, { notes: h.notes.filter(x => x.reminder_at) }));
  assert.deepEqual(first.count, none, 'the Upload');
  // A connected phone's new note, its reminder due half an hour ago too.
  const now = await sent(() => push(token, { notes: [note(30, { title: 'Written now, due', reminder_at: iso(-30 * 60000) })] }));
  assert.equal(now.count['note.created'], 1);
  // The scheduler looks every minute: wait for the two that should come.
  const fired = () => deliveries.filter(d => d.event === 'reminder.fired').map(d => d.data.title);
  for (let i = 0; i < 300 && !(fired().includes('Written now, due') && fired().includes('Uploaded, still to come')); i++) await sleep(500);
  assert.deepEqual(fired().sort(), ['Uploaded, still to come', 'Written now, due']);
  await sleep(1000);
  assert.ok(pushes.some(t => t.includes('Written now, due')), 'ntfy got the note written now');
  assert.ok(pushes.some(t => t.includes('Uploaded, still to come')), 'ntfy got the uploaded reminder still to come');
  assert.ok(!pushes.some(t => t.includes('Uploaded, already due')), 'ntfy got nothing for the uploaded reminder already due');
});

test('the app marks an Upload\'s notes as history in the push, and only those', async () => {
  const migrate = readFileSync(new URL('../src/lib/migrate.js', import.meta.url), 'utf8');
  assert.match(migrate, /dbSetMeta\('history_upload_through'/, 'Upload notes how far its notes go');
  const sync = readFileSync(new URL('../src/lib/sync.js', import.meta.url), 'utf8');
  const fn = sync.slice(sync.indexOf('async function pushChanges'), sync.indexOf('function _reportDropped'));
  assert.match(fn, /history_upload = true/, 'the push marks them');
  assert.match(fn, /table === 'notes' && !row\.server_id/, 'only a note going up as new');
});
