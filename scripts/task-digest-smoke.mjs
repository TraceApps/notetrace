/**
 * task-digest-smoke.mjs: the daily Tasks Due push against a throwaway
 * database, with a local listener standing in for ntfy. Runs inside the
 * server image (needs its better-sqlite3 build):
 *
 *   docker run --rm -v "$PWD":/repo -e DB_PATH=/tmp/t.db --entrypoint node \
 *     <image> /repo/scripts/task-digest-smoke.mjs
 */
import http from 'node:http';

const APP = process.env.APP_DIR || '/app';
let f = 0;
const ok = (c, m) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) f++; };

const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  // ntfy titles arrive RFC 2047 encoded when they hold non-Latin-1 characters.
  const raw = String(req.headers.title || '');
  const m = raw.match(/^=\?UTF-8\?B\?(.*)\?=$/);
  const title = m ? Buffer.from(m[1], 'base64').toString('utf8') : raw;
  req.on('end', () => { received.push({ title, body }); res.end('{}'); });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { default: db } = await import(`${APP}/db.js`);
const { deliverTaskDigests } = await import(`${APP}/lib/task-digest.js`);

const mkUser = (name) => Number(db.prepare(`INSERT INTO users (username, password_hash) VALUES (?, 'x')`).run(name).lastInsertRowid);
const set = (uid, k, v) => db.prepare(
  `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
).run(uid, k, JSON.stringify(v));
const note = (uid, title) => Number(db.prepare(`INSERT INTO notes (user_id, title, kind) VALUES (?, ?, 'checklist')`).run(uid, title).lastInsertRowid);
const item = (uid, noteId, text, due, checked = 0) => db.prepare(
  `INSERT INTO checklist_items (uuid, user_id, note_id, text, checked, position, due_date) VALUES (?, ?, ?, ?, ?, 1, ?)`
).run(`${noteId}-${text}`, uid, noteId, text, checked, due);

const a = mkUser('ann');
for (const [k, v] of [['notifPushService', 'ntfy'], ['ntfyUrl', `http://127.0.0.1:${port}`], ['ntfyTopic', 'tasks'], ['timezone', 'America/New_York'], ['tasksDigestTime', '08:00']]) set(a, k, v);
const groceries = note(a, 'Groceries');
item(a, groceries, 'Buy milk', '2026-09-15');
item(a, groceries, 'Return bottles', '2026-09-13');
item(a, groceries, 'Checked one', '2026-09-15', 1);
item(a, groceries, 'Next week', '2026-09-22');

// 07:30 in New York: before the Tasks Due time.
let sent = await deliverTaskDigests(new Date('2026-09-15T11:30:00Z'));
ok(sent === 0 && received.length === 0, 'nothing before the Tasks Due time');
// 08:05 in New York.
sent = await deliverTaskDigests(new Date('2026-09-15T12:05:00Z'));
await new Promise(r => setTimeout(r, 300));
ok(sent === 1 && received.length === 1, 'sent once at the Tasks Due time');
ok(/1 task due today, 1 overdue/.test(received[0]?.title || '') && /Buy milk \(Groceries\)/.test(received[0]?.body || '') && !/Checked one/.test(received[0]?.body || ''), `title and body (${received[0]?.title} / ${received[0]?.body?.replace(/\n/g, ' | ')})`);
sent = await deliverTaskDigests(new Date('2026-09-15T13:00:00Z'));
ok(sent === 0 && received.length === 1, 'not sent twice the same day');
// Next day, after the latest send time (20:00 local): skipped.
sent = await deliverTaskDigests(new Date('2026-09-17T01:30:00Z'));
ok(sent === 0, 'not sent late in the evening');

const b = mkUser('bea');
for (const [k, v] of [['notifPushService', 'ntfy'], ['ntfyUrl', `http://127.0.0.1:${port}`], ['ntfyTopic', 'tasks-b'], ['timezone', 'UTC'], ['notifTasksDue', false]]) set(b, k, v);
item(b, note(b, 'Work'), 'Report', '2026-09-15');
sent = await deliverTaskDigests(new Date('2026-09-15T10:00:00Z'));
ok(sent === 0, 'Tasks Due off sends nothing');

server.close();
console.log(f ? `${f} FAILED` : 'all passed');
process.exit(f ? 1 : 0);
