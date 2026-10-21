import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';

test('captured tasks retain source metadata through native sync and cancel offline reminders', { timeout: 60000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fixtures = new URL('./fixtures/android-sync/', import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), 'capture-native-'));
  const port = await new Promise(resolve => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const secret = 'capture-native-test-only-0123456789';
  const child = spawn(process.execPath, ['index.js'], { cwd: join(root, 'server'), stdio: 'ignore', env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'server.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: secret, INSECURE_COOKIES: '1', CAPTURE_ENABLED: '1', NODE_ENV: 'test' } });
  t.after(async () => {
    if (child.exitCode == null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'scratch server started');
  const req = async (route, body, token) => {
    const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal(r.ok, true, await r.clone().text()); return r.json();
  };
  const user = (await req('/api/auth/register', { username: 'alice', password: 'CaptureNative!234' })).user;
  const jwt = createRequire(new URL('../server/package.json', import.meta.url))('jsonwebtoken');
  const session = jwt.sign({ id: user.id, username: 'alice', role: 'admin', csrf: 'test' }, secret);
  const token = (await req('/api/admin/api-tokens', { name: 'mailflow', scopes: ['capture:write'] }, session)).raw;
  const captured = await req('/api/capture', { version: 1, request_id: 'native-save', source: { id: 'native-email', url: 'https://mail.example/?m=native', subject: 'Native capture', sender: 'sender@example.com', date: '2026-10-21' }, entries: [
    { key: 'task-1', kind: 'task', title: 'Native captured task', markdown: '**Context**', due_date: '2099-11-10', reminder_at: '2099-11-10T15:00:00Z', time_zone: 'America/Chicago' },
  ] }, token);
  const code = `
    const { open } = await import(${JSON.stringify(new URL('app.mjs', fixtures).href)}); const p = await open();
    await p.setupSignIn('alice'); await p.sync();
    let n = (await p.NotesNative.getNotes({ view: 'notes' })).find(n => n.title === 'Native captured task');
    if (!n) throw Error('captured task missing');
    const source = n.source_json;
    const waitSchedule = async () => { const before = (globalThis.__reminders || []).length; p.reminders.rescheduleReminders(); for (let i=0;i<150 && (globalThis.__reminders || []).length===before;i++) await p.sleep(20); return (globalThis.__reminders || []).at(-1) || []; };
    const armedBefore = await waitSchedule();
    await p.offline(async () => { await p.NotesNative.updateItem(n.id, n.items[0].uuid, { checked: true }); });
    const armedAfter = await waitSchedule();
    await p.sync(); n = await p.NotesNative.getNote(n.id);
    p.done({ source, sourceAfter: n.source_json, checked: n.items[0].checked, inTasks: n.in_tasks, armedBefore, armedAfter });`;
  const phoneDb = join(dir, 'phone');
  const phone = spawnSync(process.execPath, ['--import', new URL('register.mjs', fixtures).href, '--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', timeout: 40000,
    env: { ...process.env, NOTE_SERVER: base, PHONE_DB: phoneDb, PHONE_JAR: phoneDb + '.cookies.json', PHONE_TOKENS: JSON.stringify({ [base]: { alice: session } }) } });
  assert.equal(phone.status, 0, phone.stderr || phone.stdout);
  const result = JSON.parse(phone.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice(7));
  assert.equal(JSON.parse(result.source).url, 'https://mail.example/?m=native');
  assert.equal(result.source, result.sourceAfter); assert.equal(result.checked, true); assert.equal(result.inTasks, true);
  assert.ok(result.armedBefore.includes('Native captured task')); assert.ok(!result.armedAfter.includes('Native captured task'));
  const response = await fetch(base + '/api/notes/' + captured.entries[0].note_id, { headers: { Authorization: `Bearer ${session}` } });
  assert.equal((await response.json()).items[0].checked, true);
});
