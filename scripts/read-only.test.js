/**
 * Read Only notes (TraceApps/notetrace#30).
 *
 * A note can be made Read Only: it opens for reading, safe from accidental
 * edits, and Edit lifts that for one visit. It's the note's own, like its
 * color, so it syncs and everyone it's shared with sees it; anyone who can
 * edit the note can turn it off. It guards the content (title, text, items),
 * not ticking items, nor color, labels, pin, archive, reminders or trash.
 * Trace and MCP agents can't change a Read Only note's content and can't
 * turn it off. Sync and the API still take edits, so an edit made offline
 * before a note turned Read Only is never lost.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { executeNoteTool } from '../server/lib/note-tools.js';
import { itemAfterPatch } from '../server/lib/task-rules.js';
import { noteToMarkdown, parseMarkdownNote } from '../src/lib/import-export/markdown.js';
import { NOTE_FIELDS, buildPush } from '../src/lib/offline-edits.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = new URL('./fixtures/android-sync/', import.meta.url);
const req = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { req('better-sqlite3'); await import('svelte/store'); ready = true; } catch { /* the server's packages are missing: those cases skip */ }
const skip = (t) => { if (!ready) { t.skip('better-sqlite3 or the app packages are missing'); return true; } return false; };

// ── A scratch server with alice (owner), bob and carol ────────────────────
const dir = ready ? mkdtempSync(join(tmpdir(), 'note-readonly-')) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
let S = null;
async function startServer() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const secret = 'read-only-0123456789abcdef-0123456789';
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: join(root, 'server'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'ro.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: secret, INSECURE_COOKIES: '1', NODE_ENV: 'test' },
  });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {} await sleep(250); }
  const jwt = req('jsonwebtoken');
  const reg = (u, tok) => fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify({ username: u, password: 'Str0ng-Pass-77!x' }) });
  const tokens = {};
  const first = await (await reg('alice')).json();
  tokens.alice = jwt.sign({ id: first.user.id, username: 'alice', role: 'admin', csrf: 'test' }, secret, { expiresIn: '1h' });
  for (const u of ['bob', 'carol']) {
    const made = await (await reg(u, tokens.alice)).json();
    tokens[u] = jwt.sign({ id: made.user.id, username: u, role: 'user', csrf: 'test' }, secret, { expiresIn: '1h' });
  }
  return { base, proc, tokens };
}
async function web(user, method, path, body) {
  const r = await fetch(S.base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.tokens[user]}` }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
// One run of the Android app's own sync and storage code (fixtures/android-sync).
function phone(name, code) {
  const prelude = `const { open } = await import(${JSON.stringify(new URL('app.mjs', fixtures).href)}); const p = await open();\n`;
  const db = join(dir, 'phone-' + name);
  const r = spawnSync(process.execPath, ['--import', new URL('register.mjs', fixtures).href, '--input-type=module', '-e', prelude + code], {
    cwd: root, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, NOTE_SERVER: S.base, PHONE_DB: db, PHONE_JAR: db + '.cookies.json', PHONE_TOKENS: JSON.stringify({ [S.base]: S.tokens }) },
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`phone ${name} failed:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(7));
}
test.before(async () => { if (ready) S = await startServer(); });
test.after(() => { try { S?.proc.kill(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

test('a note is Read Only when made so, and only then', async (t) => {
  if (skip(t)) return;
  const n = await web('alice', 'POST', '/api/notes', { title: 'Wi-Fi', body_md: 'password: hunter2' });
  assert.equal(n.read_only, false);
  assert.equal((await web('alice', 'PATCH', `/api/notes/${n.id}`, { read_only: true })).read_only, true);
  const back = await web('alice', 'GET', `/api/notes/${n.id}`);
  assert.equal(back.read_only, true);
  // The watch's slim list says so too: it ticks a Read Only list's items but adds none.
  assert.equal((await web('alice', 'GET', '/api/notes?slim=1&watch=1')).find((x) => x.id === n.id).read_only, true);
  // Its content can still change through the API: Read Only guards against
  // accidents in the app, and an edit made offline before it is never lost.
  assert.equal((await web('alice', 'PATCH', `/api/notes/${n.id}`, { body_md: 'password: changed' })).body_md, 'password: changed');
  assert.equal((await web('alice', 'PATCH', `/api/notes/${n.id}`, { read_only: false })).read_only, false);
});

test('anyone who can edit a shared note can turn Read Only on and off; someone who can only view can\'t', async (t) => {
  if (skip(t)) return;
  const n = await web('alice', 'POST', '/api/notes', { title: 'House rules', body_md: 'Shoes off' });
  await web('alice', 'POST', `/api/notes/${n.id}/members`, { username: 'bob', role: 'edit' });
  await web('alice', 'POST', `/api/notes/${n.id}/members`, { username: 'carol', role: 'view' });
  assert.equal((await web('bob', 'PATCH', `/api/notes/${n.id}`, { read_only: true })).read_only, true);
  // Everyone it's shared with sees it Read Only.
  assert.equal((await web('carol', 'GET', `/api/notes/${n.id}`)).read_only, true);
  assert.equal((await web('alice', 'GET', `/api/notes/${n.id}`)).read_only, true);
  assert.equal((await web('carol', 'PATCH', `/api/notes/${n.id}`, { read_only: false })).read_only, true);
  assert.equal((await web('bob', 'PATCH', `/api/notes/${n.id}`, { read_only: false })).read_only, false);
});

test('an older app\'s sync never sees read_only, and what it sends leaves it as it is', async (t) => {
  if (skip(t)) return;
  const n = await web('alice', 'POST', '/api/notes', { title: 'Old phone', body_md: 'text' });
  await web('alice', 'PATCH', `/api/notes/${n.id}`, { read_only: true });
  const since = encodeURIComponent('1970-01-01 00:00:00');
  const old = (await web('alice', 'GET', `/api/sync/pull?since=${since}&keys=1`)).tables.notes.find((r) => r.id === n.id);
  assert.ok(old && !('read_only' in old), 'an older app would fail writing a column it has no place for');
  const fresh = (await web('alice', 'GET', `/api/sync/pull?since=${since}&keys=1&ro=1`)).tables.notes.find((r) => r.id === n.id);
  assert.equal(fresh.read_only, 1);
  // A whole row from an older app (no read_only in it) changes the text and keeps Read Only.
  const row = { client_id: 900, server_id: n.id, ...Object.fromEntries(['title', 'kind', 'color', 'pinned', 'archived', 'in_tasks', 'trashed_at', 'reminder_at', 'reminder_rrule', 'reminder_tz'].map((k) => [k, old[k]])),
    body_md: 'edited on an old phone', updated_at: '2999-01-01 00:00:00', deleted_at: null };
  await web('alice', 'POST', '/api/sync/push', { tables: { notes: [row] } });
  const after = await web('alice', 'GET', `/api/notes/${n.id}`);
  assert.equal(after.body_md, 'edited on an old phone');
  assert.equal(after.read_only, true);
});

test('Read Only comes down to the Android app and goes back up from it', async (t) => {
  if (skip(t)) return;
  const n = await web('bob', 'POST', '/api/notes', { title: 'Garage code', body_md: '4321' });
  await web('bob', 'PATCH', `/api/notes/${n.id}`, { read_only: true });
  const r = phone('ro', `
    await p.setupSignIn('bob');
    await p.sync();
    const mine = (await p.rows()).find(x => x.server_id === ${n.id});
    const pulled = mine.read_only;
    // Turned off on the phone, offline; it goes up with the next sync.
    await p.offline(() => p.NotesNative.updateNote(mine.id, { read_only: false }));
    await p.sync();
    p.done({ pulled, shown: (await p.NotesNative.getNote(mine.id)).read_only });`);
  assert.deepEqual(r, { pulled: 1, shown: false });
  assert.equal((await web('bob', 'GET', `/api/notes/${n.id}`)).read_only, false);
});

test('an older app\'s copy without the column applies the pull it asks for, and would fail on read_only', async (t) => {
  if (skip(t)) return;
  const n = await web('carol', 'POST', '/api/notes', { title: 'Old copy', body_md: 'x' });
  await web('carol', 'PATCH', `/api/notes/${n.id}`, { read_only: true });
  const since = encodeURIComponent('1970-01-01 00:00:00');
  const oldPull = await web('carol', 'GET', `/api/sync/pull?since=${since}&keys=1`);
  const newPull = await web('carol', 'GET', `/api/sync/pull?since=${since}&keys=1&ro=1`);
  const r = phone('old-copy', `
    await p.setupSignIn('carol');
    await p.db.run('ALTER TABLE notes DROP COLUMN read_only', []);
    const old = ${JSON.stringify(oldPull)};
    const neu = ${JSON.stringify(newPull)};
    let oldOk = true, newOk = true;
    try { await p.dbn.dbApplyPull(old); } catch { oldOk = false; }
    await p.db.run('DELETE FROM notes', []);
    try { await p.dbn.dbApplyPull(neu); } catch { newOk = false; }
    const rows = (await p.rows()).length;
    p.done({ oldOk, newOk, rows });`);
  assert.equal(r.oldOk, true, 'the pull an older app asks for goes into its copy');
  assert.ok(!r.newOk || r.rows === 0, 'read_only would not fit an older copy: why older apps never get it');
});

test('an app updated to know Read Only never turns it off: it pulls every note again first', async (t) => {
  if (skip(t)) return;
  const l = await web('alice', 'POST', '/api/notes', { kind: 'checklist', title: 'Before the update', items: [{ text: 'Passport' }] });
  const r = phone('upgrade', `
    await p.setupSignIn('alice');
    await p.sync();
    // As the app before Read Only left its copy: no column, and pulled up to now.
    await p.db.run('ALTER TABLE notes DROP COLUMN read_only', []);
    const cursorBefore = await p.dbn.dbGetMeta('last_pull_at');
    p.done({ cursorBefore: !!cursorBefore });`);
  assert.equal(r.cursorBefore, true);
  // Meanwhile, on the web, the list is made Read Only.
  await web('alice', 'PATCH', `/api/notes/${l.id}`, { read_only: true });
  const r2 = phone('upgrade', `
    // The updated app starts: its copy gains the column (0 for every note).
    await p.dbn.dbInit();
    const marker = await p.dbn.dbGetMeta('read_only_unknown');
    const cursor = await p.dbn.dbGetMeta('last_pull_at');
    const mine = (await p.rows()).find(x => x.server_id === ${l.id});
    // A tick before the first sync: the note waits to go up, read_only 0 here.
    const item = (await p.db.query('SELECT uuid FROM checklist_items WHERE note_id = ?', [mine.id])).values[0];
    await p.offline(() => p.NotesNative.updateItem(mine.id, item.uuid, { checked: true }));
    await p.sync();
    const after = (await p.rows()).find(x => x.server_id === ${l.id});
    p.done({ marker, cursor, phoneReadOnly: after.read_only, markerAfter: await p.dbn.dbGetMeta('read_only_unknown') });`);
  assert.equal(r2.marker, '1', 'the copy knows its read_only values are not known yet');
  assert.equal(r2.cursor, null, 'and pulls everything again');
  const server = await web('alice', 'GET', `/api/notes/${l.id}`);
  assert.equal(server.read_only, true, 'the tick went up without turning Read Only off');
  assert.equal(server.items[0].checked, true);
  assert.equal(r2.phoneReadOnly, 1, 'the phone has it now, also on the note that was waiting');
  assert.equal(r2.markerAfter, null);
});

// ── Trace and MCP agents ─────────────────────────────────────────────────
function fakeApi() {
  const notes = new Map();
  const clone = (n) => JSON.parse(JSON.stringify(n));
  return {
    notes,
    async getLabels() { return []; },
    async getNotes() { return [...notes.values()].map(clone); },
    async getNote(id) { return notes.has(id) ? clone(notes.get(id)) : null; },
    async updateNote(id, p) { Object.assign(notes.get(id), p); return clone(notes.get(id)); },
    async addItem(id, { text }) { const n = notes.get(id); n.items.push({ uuid: `a${n.items.length}`, text, checked: false }); return clone(n); },
    async updateItem(id, uuid, p) { const it = notes.get(id).items.find((i) => i.uuid === uuid); Object.assign(it, itemAfterPatch(it, p, '2099-01-01')); return clone(notes.get(id)); },
    async trashNote(id) { notes.get(id).trashed_at = 'now'; return clone(notes.get(id)); },
  };
}

test('Trace and MCP leave a Read Only note\'s content alone, and can\'t turn Read Only off', async () => {
  const api = fakeApi();
  const base = { labels: [], color: null, pinned: false, archived: false, reminder_at: null, share_role: 'owner' };
  api.notes.set(1, { id: 1, title: 'Wi-Fi', body_md: 'hunter2', kind: 'text', items: [], read_only: true, ...base });
  api.notes.set(2, { id: 2, title: 'Packing', body_md: '', kind: 'checklist', items: [{ uuid: 'i1', text: 'Charger', checked: false }], read_only: true, ...base });
  const run = (name, args) => executeNoteTool(name, args, api);
  for (const [name, args] of [
    ['update_note', { id: 1, text: 'changed' }],
    ['update_note', { id: 1, title: 'Changed' }],
    ['append_to_note', { id: 1, text: 'more' }],
    ['append_to_note', { id: 2, text: 'Socks' }],
    ['add_checklist_items', { id: 2, items: ['Socks'] }],
    ['set_due_date', { id: 2, item: 'Charger', due: '2026-12-01' }],
  ]) assert.match((await run(name, args)).error || '', /Read Only/, `${name} ${JSON.stringify(args)}`);
  assert.equal(api.notes.get(1).body_md, 'hunter2');
  assert.deepEqual(api.notes.get(2).items.map((i) => i.text), ['Charger']);
  // Not content: still done.
  assert.equal((await run('check_checklist_item', { id: 2, item: 'Charger' })).checked, true);
  assert.equal((await run('update_note', { id: 1, color: 'sky', pinned: true })).note.color, 'sky');
  // An agent can make a note Read Only, never undo it.
  assert.match((await run('update_note', { id: 1, read_only: false })).error, /Only the user can turn off Read Only/);
  api.notes.get(1).read_only = false;
  assert.equal((await run('update_note', { id: 1, read_only: true })).note.read_only, true);
  // It says so when it reads a note.
  assert.equal((await run('get_note', { id: 1 })).read_only, true);
  assert.equal((await run('search_notes', {})).notes.find((n) => n.id === 2).read_only, true);
});

test('Read Only goes out in a Markdown export and comes back in on import', () => {
  const md = noteToMarkdown({ title: 'Wi-Fi', body_md: 'hunter2', kind: 'text', read_only: true, created_at: '2026-10-01 10:00:00', updated_at: '2026-10-01 10:00:00' });
  assert.match(md, /^read_only: true$/m);
  assert.equal(parseMarkdownNote('Wi-Fi.md', md).read_only, true);
  const plain = noteToMarkdown({ title: 'Plain', body_md: 'x', kind: 'text', read_only: false });
  assert.doesNotMatch(plain, /read_only/);
  assert.equal(parseMarkdownNote('Plain.md', plain).read_only, false);
});

test('turned on or off without a connection in the browser, it goes up with the other changes', () => {
  assert.ok(NOTE_FIELDS.includes('read_only'));
  const before = { id: 5, title: 'T', body_md: '', kind: 'text', read_only: false, items: [], labels: [] };
  const after = { ...before, read_only: true };
  const push = buildPush([{ type: 'update', id: 5, patch: { read_only: true }, at: Date.parse('2026-10-18T10:00:00Z') }], new Map([[5, before]]), new Map([[5, after]]));
  assert.deepEqual(push.tables.notes, [{ client_id: 5, server_id: 5, updated_at: '2026-10-18 10:00:00.000', read_only: 1 }]);
});

test('the note opens for reading: content guarded, ticking and color kept, Edit for one visit', () => {
  const ed = read('../src/components/notes/NoteEditor.svelte');
  assert.match(ed, /\$: baseLocked = readOnly \|\| shareRole === 'view';/);
  assert.match(ed, /\$: guarded = readOnlyNote && !editingAnyway && !baseLocked;/);
  assert.match(ed, /\$: contentLocked = baseLocked \|\| guarded;/);
  // Edit lifts it for this visit; the note keeps read_only, so it's guarded again next time.
  assert.match(ed, /function editAnyway\(\) \{\s*editingAnyway = true;\s*\}/);
  assert.doesNotMatch(ed.slice(ed.indexOf('function editAnyway'), ed.indexOf('async function stopEditing')), /read_only/);
  // Turned on, what's typed is saved first.
  assert.match(ed, /if \(next\) await flushAll\(\);\s*readOnlyNote = next;/);
  assert.match(ed, /checkable=\{!baseLocked\}/);
  assert.equal((ed.match(/\{#if !baseLocked\}\s*<button class="icon-btn"[^\n]*openColor/g) || []).length, 2, 'color stays on the compact and full editor bars');
  assert.match(ed, /!baseLocked \? \[\{ key: 'color',[^\n]*run: openColor/, 'the responsive reader keeps color available on Read Only notes');
  assert.match(ed, /\{#each readerVisible as action \(action\.key\)\}/);
  assert.match(ed, /\{#each readerOverflow as action \(action\.key\)\}/);
  assert.match(ed, /role="menuitemcheckbox" aria-checked=\{readOnlyNote\} on:click=\{\(\) => \{ moreOpen = false; toggleReadOnly\(\); \}\}/);
  const cl = read('../src/components/notes/ChecklistEditor.svelte');
  assert.match(cl, /function toggle\(item\) \{\s*if \(!checkable\) return;/);
  assert.match(cl, /function uncheckAll\(\) \{\s*if \(!checkable\) return;/);
  assert.match(cl, /function deleteChecked\(\) \{\s*if \(!editable\) return;/);
  assert.match(read('../src/components/notes/TipTapEditor.svelte'), /TaskItem\.configure\(\{ nested: true, onReadOnlyChecked: \(\) => checkable \}\)/);
  // The public page can't tick anything.
  assert.doesNotMatch(read('../src/routes/PublicNote.svelte'), /checkable/);
  const tasks = read('../src/routes/Tasks.svelte');
  assert.match(tasks, /checkable: canEdit\(n\), editable: canChange\(n\)/);
  assert.match(tasks, /async function toggle\(task\) \{\s*if \(!task\.checkable\) return;/);
  assert.match(tasks, /\$: writableLists = notes\.filter\(n => canChange\(n\)\)/);
  assert.match(read('../src/lib/note-sharing.js'), /export const canChange = \(note\) => canEdit\(note\) && !note\?\.read_only;/);
  assert.match(read('../src/components/notes/NoteCard.svelte'), /\{#if note\.read_only\}\s*<span class="chip chip-ro"/);
  assert.match(read('../src/lib/sync.js'), /\/api\/sync\/pull\?since=\$\{encodeURIComponent\(since\)\}&keys=1&ro=1/);
  assert.match(read('../src/lib/sync.js'), /if \(table === 'notes' && readOnlyUnknown\) delete row\.read_only;/);
  // A title changed with Edit still renames the links to it on close.
  assert.match(ed, /if \(noteId && !trashed && !baseLocked && renamedFrom && title\.trim\(\) && renamedFrom !== title\.trim\(\)\)/);
  // Tasks: a Read Only list's items swipe to tick, not to delete, and Quick Add won't add to it.
  assert.match(tasks, /enabled: touch && task\.checkable && editUuid !== task\.uuid, left: task\.editable/);
  assert.match(tasks, /if \(target\.read_only\) \{ showError\(\$_\('tasks\.list_read_only'/);
  const en = JSON.parse(read('../src/i18n/en.json')).notes;
  for (const k of ['read_only', 'read_only_edit', 'read_only_editing', 'read_only_done', 'read_only_on', 'read_only_off']) assert.ok(en[k], k);
});

test('the watch ticks a Read Only list\'s items but adds none, and remembers it offline', () => {
  const wear = (f) => read(`../android/wear/src/main/java/com/notetrace/app/wear/${f}`);
  // Both the lists kept on the watch and the ones it opens from Reminders.
  assert.equal((wear('NoteApi.kt').match(/readOnly = n\.optBoolean\("read_only"\)/g) || []).length, 2);
  const store = wear('WearStore.kt');
  assert.match(store, /\.put\("read_only", it\.readOnly\)/);
  assert.match(store, /readOnly = o\.optBoolean\("read_only"\)/);
  assert.match(store, /fun addSpokenItem[\s\S]{0,200}noteOf\(noteId\)\?\.readOnly == true\) \{\s*flash\("Read Only"\)\s*return/);
  assert.match(store, /checklists\.firstOrNull \{ it\.id == noteId \} \?: _state\.value\.reminders\.firstOrNull \{ it\.id == noteId \}/);
  assert.equal((store.match(/\.put\("read_only", it\.readOnly\)/g) || []).length, 2);
  const screen = wear('MainActivity.kt');
  assert.match(screen, /val note = state\.checklists\.firstOrNull \{ it\.id == noteId \} \?: state\.reminders\.firstOrNull \{ it\.id == noteId \}/);
  assert.match(screen, /if \(note\?\.readOnly == true\) \{[\s\S]{0,240}Message\(title = "Read Only"[\s\S]{0,120}\} else \{\s*item \{ SpeakButton\("Add an item", speak\) \}/);
  // A list opened from Reminders that isn't kept on the watch opens with its items.
  assert.match(wear('NoteApi.kt'), /if \(n\.optString\("kind"\) == "checklist"\) items\[n\.getLong\("id"\)\] = itemsOf\(n\)/);
  assert.match(store, /val \(upcoming, remindItems\) = remindJob\.await\(\)[\s\S]{0,400}items = remindItems \+ items,/);
  // Ticking and Uncheck All stay.
  assert.match(screen, /store\.setItemChecked\(noteId, item\.uuid, true\)/);
  assert.match(screen, /store\.uncheckAll\(noteId\)/);
});
