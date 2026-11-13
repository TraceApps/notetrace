/**
 * Local mode on the watch: with no server, the watch sends its requests to the
 * phone, and the phone's own local handlers answer them.
 *
 * The routing is checked on its own, then the whole round trip runs against
 * the phone's real Local mode code (notes-native.js on the SQLite shim from
 * scripts/fixtures/android-sync): the watch's lists and reminders read the
 * way a server gives them, a note said aloud, an item added and ticked, a
 * reminder done, and a tick that waited being left out when the phone
 * changed the item after it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { answerWatchRequest, PHONE_ADDRESS } from '../src/lib/watch-relay.js';
import { watchNote } from '../server/lib/note-excerpt.js';

function fakeApi() {
  const calls = [];
  const note = { id: 4, title: 'Groceries', kind: 'checklist', body_md: '', pinned: 0, read_only: 0, items: [{ uuid: 'u1', text: 'Milk', checked: 0, position: 1 }] };
  const api = {
    getNotes: async (o) => { calls.push(['list', o.view]); return [note, { id: 5, title: 'Idea', kind: 'text', body_md: '**Bold** idea' }]; },
    getNote: async (id) => (id === 4 ? note : id === 5 ? { id: 5, kind: 'text' } : null),
    createNote: async (d) => { calls.push(['create', d]); return { id: 9, ...d }; },
    updateNote: async (id, p) => { calls.push(['note', id, p]); if (id !== 4) throw new Error('Note not found'); return note; },
    addItem: async (id, d) => { calls.push(['add', id, d]); return note; },
    updateItem: async (id, uuid, p) => { calls.push(['item', id, uuid, p]); if (uuid !== 'u1') throw new Error('Item not found'); return note; },
  };
  return { api, calls };
}

test('the watch gets its notes as a server gives them, all or only the chosen ones', async () => {
  const { api, calls } = fakeApi();
  const ask = (path, watchNotes) => answerWatchRequest({ method: 'GET', path }, { localMode: true, api, watchNotes });
  const all = await ask('/api/notes?slim=1&watch=1', () => []);
  assert.equal(all.status, 200);
  assert.deepEqual(JSON.parse(all.body).map(n => n.id), [4, 5]);
  assert.deepEqual(JSON.parse(all.body)[1], JSON.parse(JSON.stringify(watchNote({ id: 5, title: 'Idea', kind: 'text', body_md: '**Bold** idea' }))));
  assert.equal(JSON.parse(all.body)[1].excerpt, 'Bold idea', 'the marks taken out, as the server does');
  const chosen = await ask('/api/notes?slim=1&watch=1', () => [5]);
  assert.deepEqual(JSON.parse(chosen.body).map(n => n.id), [5]);
  const notChosen = await ask('/api/notes?slim=1', () => [5]);
  assert.deepEqual(JSON.parse(notChosen.body).map(n => n.id), [4, 5], 'only watch=1 narrows it');
  await ask('/api/notes?view=reminders&slim=1');
  assert.deepEqual(calls.map(c => c[1]), ['notes', 'notes', 'notes', 'reminders']);
  assert.equal(all.changed, undefined);
});

test('only what the watch writes is answered, and only the fields it sends', async () => {
  const { api, calls } = fakeApi();
  const ask = (method, path, body) => answerWatchRequest({ method, path, body: body ? JSON.stringify(body) : null }, { localMode: true, api });
  const made = { edited_at: '2026-11-13T10:00:00Z', client_now: '2026-11-13T10:05:00Z' };
  assert.equal((await ask('POST', '/api/notes', { title: 'Call Sam', body_md: '', kind: 'text', reminder_at: '2026-11-14T09:00:00Z', reminder_tz: 'UTC', pinned: true })).status, 201);
  assert.equal((await ask('PATCH', '/api/notes/4', { reminder_at: null, archived: true, ...made })).status, 200);
  assert.equal((await ask('POST', '/api/notes/4/items', { text: 'Eggs', checked: true })).status, 201);
  assert.equal((await ask('PATCH', '/api/notes/4/items/u1', { checked: true, text: 'changed', ...made })).status, 200);
  assert.deepEqual(calls, [
    ['create', { title: 'Call Sam', body_md: '', kind: 'text', reminder_at: '2026-11-14T09:00:00Z', reminder_tz: 'UTC' }],
    ['note', 4, { reminder_at: null, ...made }],
    ['add', 4, { text: 'Eggs' }],
    ['item', 4, 'u1', { checked: true, ...made }],
  ]);
  calls.length = 0;
  for (const [m, p] of [['DELETE', '/api/notes/4'], ['GET', '/api/notes'], ['GET', '/api/notes/4'], ['PUT', '/api/notes/4'],
    ['GET', '/api/settings'], ['POST', '/api/ai/chat'], ['GET', '/api/notes/4/../../auth/me'], ['POST', '/api/notes/4/convert']]) {
    assert.equal((await ask(m, p)).status, 404, `${m} ${p} is refused`);
  }
  assert.equal(calls.length, 0, 'nothing refused reached the handlers');
});

test('a missing note or item is not found, CookTrace is unlinked, a server-mode phone refuses', async () => {
  const { api } = fakeApi();
  const ask = (method, path, body, localMode = true) => answerWatchRequest({ method, path, body: body ? JSON.stringify(body) : null }, { localMode, api });
  assert.equal((await ask('PATCH', '/api/notes/8', { reminder_at: null })).status, 404);
  assert.equal((await ask('PATCH', '/api/notes/4/items/u9', { checked: true })).status, 404);
  assert.equal((await ask('POST', '/api/notes/5/items', { text: 'x' })).status, 404, 'a text note takes no items');
  assert.equal((await ask('POST', '/api/notes/8/items', { text: 'x' })).status, 404);
  for (const [m, p] of [['GET', '/api/integrations/cooktrace/shopping'], ['POST', '/api/integrations/cooktrace/shopping'], ['PATCH', '/api/integrations/cooktrace/shopping/3']]) {
    assert.equal((await ask(m, p, {})).status, 409, `${m} ${p}: the watch's "CookTrace isn't linked"`);
  }
  assert.equal((await ask('GET', '/api/notes?slim=1', null, false)).status, 409);
  assert.equal((await answerWatchRequest({ method: 'PATCH', path: '/api/notes/4', body: '{nope' }, { localMode: true, api })).status, 400);
  const failing = await answerWatchRequest({ method: 'GET', path: '/api/notes?slim=1' }, { localMode: true, api: { getNotes: async () => { throw new Error('disk full'); } } });
  assert.deepEqual([failing.status, JSON.parse(failing.body).error], [500, 'disk full']);
  assert.equal((await ask('PATCH', '/api/notes/4/items/u1', { checked: true })).changed, true);
  assert.equal(PHONE_ADDRESS, 'phone:', 'the watch looks for exactly this (Pairing.PHONE)');
});

let sqliteOk = true;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); } catch { sqliteOk = false; }

test("the watch's notes go through the phone's own Local mode code", { skip: !sqliteOk }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-watch-'));
  const fixtures = new URL('./fixtures/android-sync/', import.meta.url);
  const code = `
    const { open } = await import(${JSON.stringify(new URL('app.mjs', fixtures).href)});
    const p = await open();
    p.platform.setNativeMode('local');
    const { NoteApiNative } = await import(p.SRC + 'lib/api-native.js');
    const { answerWatchRequest } = await import(p.SRC + 'lib/watch-relay.js');
    const ask = async (method, path, body) => {
      const r = await answerWatchRequest({ method, path, body: body ? JSON.stringify(body) : null }, { localMode: true, api: NoteApiNative, watchNotes: () => [] });
      return { status: r.status, body: JSON.parse(r.body) };
    };
    const list = await NoteApiNative.createNote({ title: 'Groceries', kind: 'checklist', items: [{ text: 'Milk' }] });
    const said = await ask('POST', '/api/notes', { title: 'Call Sam', body_md: '', kind: 'text', reminder_at: '2099-01-01T09:00:00Z', reminder_tz: 'UTC' });
    const added = await ask('POST', '/api/notes/' + list.id + '/items', { text: 'Eggs' });
    const milk = added.body.items.find(i => i.text === 'Milk');
    const ticked = await ask('PATCH', '/api/notes/' + list.id + '/items/' + milk.uuid, { checked: true });
    const notes = await ask('GET', '/api/notes?slim=1&watch=1');
    const reminders = await ask('GET', '/api/notes?view=reminders&slim=1');
    // A tick made on the watch an hour ago, offline, arrives after the phone
    // unticked the item: the phone's later change stands.
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    await NoteApiNative.updateItem(list.id, milk.uuid, { checked: false });
    const stale = await ask('PATCH', '/api/notes/' + list.id + '/items/' + milk.uuid, { checked: true, edited_at: hourAgo, client_now: new Date().toISOString() });
    // One made after it goes in.
    await new Promise(r => setTimeout(r, 1100));
    const fresh = await ask('PATCH', '/api/notes/' + list.id + '/items/' + milk.uuid, { checked: true, edited_at: new Date().toISOString(), client_now: new Date().toISOString() });
    // A second tap made a moment after the first, arriving after it: it stands.
    const t1 = new Date(Date.now() - 2000).toISOString(), t2 = new Date(Date.now() - 1000).toISOString();
    await ask('PATCH', '/api/notes/' + list.id + '/items/' + milk.uuid, { checked: false, edited_at: t1, client_now: new Date().toISOString() });
    const second = await ask('PATCH', '/api/notes/' + list.id + '/items/' + milk.uuid, { checked: true, edited_at: t2, client_now: new Date().toISOString() });
    // A checklist with a reminder: items ticked on the watch, then Done, all
    // queued offline and sent together. The Done still clears it.
    const job = await NoteApiNative.createNote({ title: 'Chores', kind: 'checklist', items: [{ text: 'Sweep' }], reminder_at: '2099-02-01T09:00:00Z' });
    const shownAt = (await NoteApiNative.getNote(job.id)).reminder_at;
    const sweep = job.items[0].uuid;
    // Done on the watch after the list reached it, then sent later.
    await new Promise(r => setTimeout(r, 1100));
    const before = new Date().toISOString();
    await ask('PATCH', '/api/notes/' + job.id + '/items/' + sweep, { checked: true, edited_at: before, client_now: new Date().toISOString() });
    await ask('PATCH', '/api/notes/' + job.id, { reminder_at: null, reminder_seen: shownAt, edited_at: before, client_now: new Date().toISOString() });
    const jobAfter = await NoteApiNative.getNote(job.id);
    // Moved on the phone after the watch showed it: the move stands.
    const moved = await NoteApiNative.createNote({ title: 'Dentist', kind: 'text', reminder_at: '2099-03-01T09:00:00Z' });
    const oldShown = (await NoteApiNative.getNote(moved.id)).reminder_at;
    await NoteApiNative.updateNote(moved.id, { reminder_at: '2099-03-02T09:00:00Z' });
    await ask('PATCH', '/api/notes/' + moved.id, { reminder_at: null, reminder_seen: oldShown, edited_at: before, client_now: new Date().toISOString() });
    const movedAfter = await NoteApiNative.getNote(moved.id);
    const done = await ask('PATCH', '/api/notes/' + said.body.id, { reminder_at: null });
    const after = await NoteApiNative.getNote(said.body.id);
    p.done({ list: list.id, said, added, ticked, notes, reminders, stale, fresh, second, jobAfter, movedAfter, reminderAfter: after.reminder_at });`;
  const r = spawnSync(process.execPath, ['--import', new URL('register.mjs', fixtures).href, '--input-type=module', '-e', code], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PHONE_DB: join(dir, 'phone'), PHONE_JAR: join(dir, 'phone.cookies.json'), PHONE_TOKENS: '{}' },
  });
  rmSync(dir, { recursive: true, force: true });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `the phone run failed:\n${r.stdout}\n${r.stderr}`);
  const x = JSON.parse(line.slice(7));
  assert.equal(x.said.status, 201);
  assert.equal(x.said.body.title, 'Call Sam');
  assert.equal(x.added.status, 201);
  assert.deepEqual(x.added.body.items.map(i => i.text), ['Milk', 'Eggs']);
  assert.equal(x.ticked.status, 200);
  const groceries = x.notes.body.find(n => n.id === x.list);
  assert.deepEqual(Object.keys(groceries).sort(), ['excerpt', 'id', 'items', 'kind', 'pinned', 'read_only', 'reminder_at', 'reminder_rrule', 'title', 'updated_at']);
  assert.deepEqual(groceries.items.map(i => [i.text, i.checked]), [['Milk', true], ['Eggs', false]]);
  assert.deepEqual(x.reminders.body.map(n => n.title), ['Call Sam']);
  assert.equal(x.stale.status, 200);
  assert.equal(x.stale.body.items.find(i => i.text === 'Milk').checked, false, 'the phone changed it after the watch did: the phone wins');
  assert.equal(x.fresh.body.items.find(i => i.text === 'Milk').checked, true);
  assert.equal(x.reminderAfter, null, 'Done on the watch clears it');
  assert.equal(x.second.body.items.find(i => i.text === 'Milk').checked, true, 'a second tap made after the first stands');
  assert.equal(x.jobAfter.reminder_at, null, 'Done after ticking the same list on the watch still clears it');
  assert.equal(x.jobAfter.items[0].checked, true);
  assert.ok(x.movedAfter.reminder_at, 'a reminder moved on the phone after the watch showed it stays');
});
