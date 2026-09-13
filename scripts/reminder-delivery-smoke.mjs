/**
 * reminder-delivery-smoke.mjs: server reminder delivery against a
 * throwaway database, with a local listener standing in for ntfy.
 * Runs inside the server image (needs its better-sqlite3 build):
 *
 *   docker run --rm -v "$PWD":/repo -e DB_PATH=/tmp/r.db --entrypoint node \
 *     <image> /repo/scripts/reminder-delivery-smoke.mjs
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
  req.on('end', () => { received.push({ path: req.url, title, body }); res.end('{}'); });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { default: db } = await import(`${APP}/db.js`);
const { deliverDueReminders } = await import(`${APP}/lib/reminder-delivery.js`);
const { toUtcString } = await import(`${APP}/lib/reminders.js`);

const uid = Number(db.prepare(`INSERT INTO users (username, password_hash) VALUES ('rem', 'x')`).run().lastInsertRowid);
const set = (k, v) => db.prepare(
  `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
).run(uid, k, JSON.stringify(v));
set('notifPushService', 'ntfy');
set('ntfyUrl', `http://127.0.0.1:${port}`);
set('ntfyTopic', 'notes');

const now = new Date();
const mk = (title, at, extra = {}) => Number(db.prepare(
  `INSERT INTO notes (user_id, title, body_md, kind, reminder_at, reminder_rrule, reminder_tz, trashed_at)
   VALUES (?, ?, ?, 'text', ?, ?, 'UTC', ?)`
).run(uid, title, extra.body || '', toUtcString(at), extra.repeat || null, extra.trashed ? toUtcString(now) : null).lastInsertRowid);

mk('Due now', new Date(now - 30_000), { body: 'Call the **vet**' });
mk('Future', new Date(+now + 3600_000));
mk('Stale', new Date(now - 5 * 3600_000));
mk('Trashed', new Date(now - 30_000), { trashed: true });
mk('Daily standup', new Date(now - 3 * 86400_000 - 60_000), { repeat: 'daily' });

let sent = await deliverDueReminders(now);
await new Promise(r => setTimeout(r, 200));
const titles = received.map(r => r.title).join(' | ');
ok(sent === 2, `two reminders due (sent ${sent}: ${titles})`);
ok(received.some(r => /Due now/.test(r.title) && r.body === 'Call the vet'), 'one-off delivered with plain-text body');
ok(received.some(r => /Daily standup/.test(r.title)), 'repeating reminder delivered on a later day');
ok(!received.some(r => /Stale|Future|Trashed/.test(r.title)), 'future, stale, and trashed reminders not sent');

sent = await deliverDueReminders(new Date(+now + 60_000));
ok(sent === 0, 'same occurrence never sent twice');

set('notifNoteReminders', false);
mk('Muted', new Date(now - 10_000));
const before = received.length;
sent = await deliverDueReminders(new Date(+now + 120_000));
await new Promise(r => setTimeout(r, 200));
ok(sent === 1 && received.length === before, 'Note Reminders off: occurrence claimed, no push');

server.close();
console.log(f ? `${f} FAILED` : 'all passed');
process.exit(f ? 1 : 0);
