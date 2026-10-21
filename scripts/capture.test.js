import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('capture API imports native tasks atomically, isolates owners, and retries safely', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notetrace-capture-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.JWT_SECRET = 'capture-test-secret-only';
  process.env.CAPTURE_ENABLED = '1';
  process.env.UPLOADS_PATH = path.join(dir, 'uploads');
  const { default: db } = await import('../server/db.js');
  const { default: express } = await import('../server/node_modules/express/index.js');
  const { default: cookieParser } = await import('../server/node_modules/cookie-parser/index.js');
  const { authenticate, signToken } = await import('../server/middleware/auth.js');
  const { csrfProtect } = await import('../server/middleware/csrf.js');
  const { createToken } = await import('../server/lib/api-tokens.js');
  const { default: capture } = await import('../server/routes/capture.js');
  const { default: captureTokens } = await import('../server/routes/capture-tokens.js');
  const { default: sync } = await import('../server/routes/sync.js');
  const { default: backup } = await import('../server/routes/full-backup.js');
  const Notes = await import('../server/lib/notes.js');
  const { captureReminderActive } = await import('../server/lib/capture-state.js');
  const { noteToMarkdown, parseMarkdownNote } = await import('../src/lib/import-export/markdown.js');
  const u1 = Number(db.prepare("INSERT INTO users (username, role) VALUES ('capture-user', 'user')").run().lastInsertRowid);
  const u2 = Number(db.prepare("INSERT INTO users (username, role) VALUES ('other-user', 'user')").run().lastInsertRowid);
  const token = createToken({ userId: u1, name: 'mailflow', scopes: ['capture:write'] }).raw;
  const other = createToken({ userId: u2, name: 'other', scopes: ['capture:write'] }).raw;
  const readOnly = createToken({ userId: u1, name: 'read', scopes: ['mcp:read'] }).raw;
  const app = express();
  app.use(express.json(), cookieParser(), authenticate, csrfProtect);
  app.use('/api/capture', capture); app.use('/api/capture-tokens', captureTokens); app.use('/api/sync', sync);
  app.use('/api/full-backup', backup);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = async (method, route, body, auth = token) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  const payload = { version: 1, request_id: 'request-one', source: { id: 'email-1', url: 'https://mail.example/?m=id', subject: 'Invoice', sender: 'a@example.com', date: '2026-10-21' },
    entries: [{ key: 'summary', kind: 'note', title: 'Invoice summary', markdown: '# Summary\n\nPay **invoice**.', time_zone: 'America/Chicago' },
      { key: 'task-pay', kind: 'task', title: 'Pay invoice', markdown: '[Source](https://mail.example/?m=id)', due_date: '2099-11-10', reminder_at: '2099-11-10T15:00:00Z', time_zone: 'America/Chicago' }] };
  await t.test('requires explicit enablement and capture scope', async () => {
    process.env.CAPTURE_ENABLED = '0'; assert.equal((await request('GET', '/api/capture/capabilities')).status, 404);
    process.env.CAPTURE_ENABLED = '1';
    assert.equal((await request('GET', '/api/capture/capabilities', null, readOnly)).status, 403);
    assert.equal((await request('GET', '/api/capture/capabilities', null, 'bad')).status, 401);
    assert.equal((await request('GET', '/api/capture/capabilities')).data.version, 1);
  });
  let result;
  await t.test('stores Markdown and native task dates with source metadata', async () => {
    result = await request('POST', '/api/capture', payload);
    assert.equal(result.status, 200);
    const note = Notes.getNote(u1, result.data.entries[0].note_id);
    const task = Notes.getNote(u1, result.data.entries[1].note_id);
    assert.equal(note.body_md, payload.entries[0].markdown);
    assert.equal(task.kind, 'checklist'); assert.equal(task.in_tasks, true);
    assert.equal(task.items[0].due_date, '2099-11-10');
    assert.equal(JSON.parse(task.source_json).url, payload.source.url);
    assert.equal(Notes.getNote(u2, task.id), null);
  });
  await t.test('lost-response retry and repeated item capture never duplicate or overwrite', async () => {
    assert.equal((await request('POST', '/api/capture', payload)).data.replayed, true);
    const changed = structuredClone(payload); changed.entries[0].markdown = 'Different';
    assert.equal((await request('POST', '/api/capture', changed)).status, 409);
    changed.request_id = 'another-request';
    const again = await request('POST', '/api/capture', changed);
    assert.ok(again.data.entries.every(e => e.status === 'existing'));
    assert.equal(Notes.listNotes(u1).length, 2);
    assert.equal(Notes.getNote(u1, result.data.entries[0].note_id).body_md, payload.entries[0].markdown);
  });
  await t.test('receipts are isolated by account', async () => {
    const second = await request('POST', '/api/capture', payload, other);
    assert.equal(second.status, 200); assert.notEqual(second.data.entries[0].note_id, result.data.entries[0].note_id);
  });
  await t.test('invalid later entries roll back the whole batch', async () => {
    const invalid = structuredClone(payload); invalid.request_id = 'rollback'; invalid.source.id = 'new-email'; invalid.entries[1].reminder_at = '2000-01-01T00:00:00Z';
    const before = Notes.listNotes(u1).length;
    assert.equal((await request('POST', '/api/capture', invalid)).status, 400);
    assert.equal(Notes.listNotes(u1).length, before);
    assert.equal(db.prepare("SELECT count(*) n FROM capture_entries WHERE source_id = 'new-email'").get().n, 0);
  });
  await t.test('completion suppresses imported task reminders and undo restores them', () => {
    let task = Notes.getNote(u1, result.data.entries[1].note_id);
    assert.equal(captureReminderActive(task), true);
    task = Notes.updateItem(u1, task.id, task.items[0].uuid, { checked: true });
    assert.equal(captureReminderActive(task), false);
    task = Notes.updateItem(u1, task.id, task.items[0].uuid, { checked: false });
    assert.equal(captureReminderActive(task), true);
    assert.equal(captureReminderActive({ ...task, trashed_at: 'now' }), false);
  });
  await t.test('new sync clients receive metadata and old clients retain their schema', async () => {
    const auth = signToken({ id: u1, username: 'capture-user', role: 'user' });
    const current = await request('GET', '/api/sync/pull?capture=1&ro=1', null, auth);
    assert.equal(current.status, 200); assert.ok(current.data.tables.notes[0].source_json);
    const old = await request('GET', '/api/sync/pull?ro=1', null, auth);
    assert.ok(!('source_json' in old.data.tables.notes[0]));
  });
  await t.test('Markdown export and import preserve source metadata', () => {
    const note = Notes.getNote(u1, result.data.entries[0].note_id);
    const markdown = noteToMarkdown(note);
    assert.ok(markdown.includes('source_json:'));
    const parsed = parseMarkdownNote('capture.md', markdown);
    assert.equal(parsed.source_json, note.source_json);
  });
  await t.test('ordinary users can mint only their own capture tokens', async () => {
    const auth = signToken({ id: u1, username: 'capture-user', role: 'user' });
    const created = await request('POST', '/api/capture-tokens', { name: 'new-capture', scopes: ['capture:write'] }, auth);
    assert.equal(created.status, 201); assert.ok(created.data.raw.startsWith('note_pat_'));
    assert.equal((await request('POST', '/api/capture-tokens', { name: 'escalate', scopes: ['mcp:write'] }, auth)).status, 403);
    const list = await request('GET', '/api/capture-tokens', null, auth);
    assert.ok(list.data.tokens.every(t => t.scopes.length === 1 && t.scopes[0] === 'capture:write'));
    const otherAuth = signToken({ id: u2, username: 'other-user', role: 'user' });
    assert.equal((await request('DELETE', `/api/capture-tokens/${created.data.token.id}`, null, otherAuth)).status, 404);
    assert.equal((await request('DELETE', `/api/capture-tokens/${created.data.token.id}`, null, auth)).status, 200);
    assert.equal((await request('GET', '/api/capture/capabilities', null, created.data.raw)).status, 401);
  });
  await t.test('backup restore retains source metadata and safe-retry receipts', async () => {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u1);
    const auth = signToken({ id: u1, username: 'capture-user', role: 'admin' });
    const created = await request('POST', '/api/full-backup', {}, auth);
    assert.equal(created.status, 200);
    const filename = created.data.filename;
    assert.ok(filename);
    db.prepare('DELETE FROM capture_requests').run(); db.prepare('DELETE FROM capture_entries').run();
    const restored = await request('POST', `/api/full-backup/${filename}/restore`, {}, auth);
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal((await request('POST', '/api/capture', payload)).data.replayed, true);
    assert.equal(JSON.parse(Notes.getNote(u1, result.data.entries[1].note_id).source_json).url, payload.source.url);
  });
});
