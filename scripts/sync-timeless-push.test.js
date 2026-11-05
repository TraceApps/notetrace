/**
 * POST /api/sync/push and rows deleted on the server (the rule LiftTrace's
 * push follows too): a pushed copy with no readable updated_at (none, text
 * that isn't a time, a number like 1e20) can't be told from a stale one, so
 * it never brings back a row deleted here, and no such time fails the push.
 * An edit made after the delete still does. Settings follow the same rule
 * against Clear All Settings.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';

let skip = false;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); } catch { skip = 'needs the server dependencies'; }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

let proc = null, dir = null, base = null, token = null;
test.before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'note-timeless-'));
  const port = await freePort();
  proc = spawn(process.execPath, ['index.js'], {
    cwd: new URL('../server/', import.meta.url),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'app.db'), UPLOADS_PATH: join(dir, 'uploads'),
      JWT_SECRET: 'timeless-push-test-secret-0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(base + '/api/auth/me'); break; } catch { await sleep(100); }
    if (i > 150) throw new Error('server did not start');
  }
  const reg = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'writer', password: 'Str0ng-Pass-88!y' }),
  });
  token = reg.headers.getSetCookie().map(c => c.split(';')[0].split('=')[1]).find(v => v?.startsWith('eyJ'));
});
test.after(() => { proc?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function call(method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
const push = (tables, extra = {}) => call('POST', '/api/sync/push', { tables, client_now: new Date().toISOString(), ...extra });
const pulled = async (table, id) => (await call('GET', '/api/sync/pull?since=1970-01-01')).body.tables[table].find(r => r.id === id);
const pulledLink = async (note, label) => (await call('GET', '/api/sync/pull?since=1970-01-01')).body.tables.note_labels.find(r => r.note_id === note && r.label_id === label);

async function deletedNote() {
  const { id } = (await call('POST', '/api/notes', { title: 'Shop', body_md: 'milk' })).body;
  await call('DELETE', `/api/notes/${id}`);
  await call('DELETE', `/api/notes/${id}/forever`);
  return id;
}
let n = 0;
async function deletedLabel() {
  const { id } = (await call('POST', '/api/labels', { name: `Label ${++n}` })).body;
  await call('DELETE', `/api/labels/${id}`);
  return id;
}

const TIMELESS = [['no updated_at', undefined], ['null', null], ['text that is no time', 'yesterday'], ['1e20', 1e20], ['-1e20', -1e20]];

for (const [label, at] of TIMELESS) {
  for (const app of ['this app', 'an app that sends no client_now']) {
    test(`a pushed copy with ${label} leaves a deleted row deleted (${app})`, { skip }, async () => {
      const extra = app === 'this app' ? {} : { client_now: undefined };
      const note = await deletedNote(), label = await deletedLabel();
      await sleep(1100); // it arrives later than the delete, as it would
      const row = (id, v) => ({ client_id: id, server_id: id, ...v, deleted_at: null, ...(at === undefined ? {} : { updated_at: at }) });
      const r = await push({
        notes: [row(note, { title: 'Shop (phone)', body_md: 'milk' })],
        labels: [row(label, { name: `Label ${++n} (phone)` })],
      }, extra);
      assert.equal(r.status, 200);
      assert.notEqual((await pulled('notes', note)).deleted_at, null);
      assert.notEqual((await pulled('labels', label)).deleted_at, null);
    });
  }
}

test('an edit made after the delete still brings the row back', { skip }, async () => {
  const label = await deletedLabel();
  await sleep(1100);
  const r = await push({ labels: [{ client_id: 1, server_id: label, name: 'Back', updated_at: new Date().toISOString(), deleted_at: null }] });
  assert.equal(r.status, 200);
  assert.equal((await pulled('labels', label)).deleted_at, null);
});

test('a label put back on a note with no time of its own goes back on, as before', { skip }, async () => {
  const note = (await call('POST', '/api/notes', { title: 'Tagged', body_md: '' })).body.id;
  const label = (await call('POST', '/api/labels', { name: `Label ${++n}` })).body.id;
  const link = extra => push({ note_labels: [{ client_id: 5, note_id: note, label_id: label, ...extra }] });
  await link({ updated_at: new Date().toISOString(), deleted_at: null });
  await sleep(1100);
  await link({ updated_at: new Date().toISOString(), deleted_at: new Date().toISOString() });
  assert.notEqual((await pulled('note_labels', (await pulledLink(note, label)).id)).deleted_at, null, 'taken off');
  await sleep(1100);
  const r = await link({ deleted_at: null });
  assert.equal(r.status, 200);
  assert.equal((await pulledLink(note, label)).deleted_at, null);
});

test('no pushed time fails the push: the other rows in it go in', { skip }, async () => {
  const now = new Date().toISOString();
  const r = await push({ labels: [
    { client_id: 7, name: 'Good', updated_at: now },
    { client_id: 8, name: 'Big', updated_at: 1e20 },
    { client_id: 9, name: 'Small', updated_at: -1e20 },
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.body.tables.labels.filter(x => x.server_id).length, 3);
});

test('Clear All Settings: only a change made after it brings a setting back', { skip }, async () => {
  await call('PUT', '/api/settings', { key: 'accentColor', value: 'mint' });
  await call('PUT', '/api/settings', { key: 'timeFormat', value: '24h' });
  await call('PUT', '/api/settings', { key: 'dateFormat', value: 'iso' });
  const before = new Date(Date.now() - 2000).toISOString();
  await call('DELETE', '/api/settings');
  await sleep(1100);
  const r = await push({}, { settings: [
    { key: 'accentColor', value: 'mint', updated_at: before },               // made before the reset
    { key: 'dateFormat', value: 'iso' },                                     // no time of its own
    { key: 'timeFormat', value: '12h', updated_at: new Date().toISOString() }, // made after it
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual((await call('GET', '/api/settings')).body, { timeFormat: '12h' });
});
