/**
 * notes-api-smoke.mjs: end-to-end check of the notes, labels, search,
 * versions, trash, sync, and backup APIs.
 *
 * Run ONLY against a throwaway instance: it registers an admin account,
 * creates data, and restores a backup over the database.
 *
 *   docker run -d -p 3004:3001 -e JWT_SECRET=... <image>
 *   NOTETRACE_URL=http://localhost:3004 node scripts/notes-api-smoke.mjs
 */
const B = process.env.NOTETRACE_URL || 'http://localhost:3004';
let token = '';
let failures = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok  ', msg); else { failures++; console.log('  FAIL', msg); } };
async function api(method, path, body) {
  const res = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

await api('POST', '/api/auth/register', { username: 'admin', password: 'Phase1!Test', full_name: 'Admin' });
token = (await api('POST', '/api/auth/login', { username: 'admin', password: 'Phase1!Test' })).json.token;
ok(!!token, 'login');

console.log('notes');
const t = (await api('POST', '/api/notes', { title: 'Homelab to-do', body_md: 'Move **Jellyfin** transcodes to the Arc card', color: 'tide' })).json;
ok(t.id && t.kind === 'text' && t.color === 'tide', 'create text note');
const c = (await api('POST', '/api/notes', { title: 'Groceries', kind: 'checklist', items: [{ text: 'Limes' }, { text: 'Jasmine rice' }] })).json;
ok(c.items.length === 2 && c.items[0].uuid, 'create checklist with items');
const bad = await api('POST', '/api/notes', { title: 'x', color: 'neon' });
ok(bad.json.color === null, 'unknown color rejected to null');

console.log('items');
let n = (await api('POST', `/api/notes/${c.id}/items`, { text: 'Cilantro' })).json;
ok(n.items.length === 3 && n.items[2].text === 'Cilantro', 'add item appends');
const [i1, i2, i3] = n.items.map(i => i.uuid);
n = (await api('PUT', `/api/notes/${c.id}/items/order`, { uuids: [i3, i1, i2] })).json;
ok(n.items.map(i => i.uuid).join() === [i3, i1, i2].join(), 'reorder items');
for (const u of [i1, i2]) await api('PATCH', `/api/notes/${c.id}/items/${u}`, { checked: true });
n = (await api('DELETE', `/api/notes/${c.id}/items/${i3}`)).json;
ok(n.items.length === 2 && n.items.every(i => i.checked), 'check + delete item');

console.log('labels');
const home = (await api('POST', '/api/labels', { name: 'Home', color: 'moss' })).json;
const dup = await api('POST', '/api/labels', { name: 'home' });
ok(home.id && dup.status === 400, 'create label, duplicate name rejected');
n = (await api('PATCH', `/api/notes/${c.id}`, { labels: [home.id] })).json;
ok(n.labels.length === 1, 'attach label');
let labels = (await api('GET', '/api/labels')).json;
ok(labels[0].note_count === 1, 'label note_count');
const filtered = (await api('GET', `/api/notes?label=${home.id}`)).json;
ok(filtered.length === 1 && filtered[0].id === c.id, 'filter by label');
n = (await api('PATCH', `/api/notes/${c.id}`, { labels: [] })).json;
n = (await api('PATCH', `/api/notes/${c.id}`, { labels: [home.id] })).json;
ok(n.labels.length === 1, 'detach + re-attach label (revive link row)');

console.log('search');
let s = (await api('GET', '/api/notes?q=jelly')).json;
ok(s.length === 1 && s[0].id === t.id, 'prefix search in body');
s = (await api('GET', '/api/notes?q=jasmine')).json;
ok(s.length === 1 && s[0].id === c.id, 'search checklist item text');
s = (await api('GET', `/api/notes?q=${encodeURIComponent('") OR 1=1 --')}`)).json;
ok(Array.isArray(s), 'hostile search input is safe');

console.log('pin / archive / versions / convert');
n = (await api('PATCH', `/api/notes/${t.id}`, { pinned: true })).json;
let list = (await api('GET', '/api/notes')).json;
ok(list[0].id === t.id && n.pinned, 'pinned note sorts first');
n = (await api('PATCH', `/api/notes/${t.id}`, { body_md: 'Move Jellyfin transcodes. Renew the cert.' })).json;
let versions = (await api('GET', `/api/notes/${t.id}/versions`)).json;
ok(versions.length === 1 && versions[0].body_md.includes('Arc card'), 'first edit snapshots previous content');
await api('PATCH', `/api/notes/${t.id}`, { body_md: 'second edit in same session' });
versions = (await api('GET', `/api/notes/${t.id}/versions`)).json;
ok(versions.length === 1, 'edits within a session do not add versions');
n = (await api('POST', `/api/notes/${t.id}/versions/${versions[0].id}/restore`)).json;
ok(n.body_md.includes('Arc card'), 'restore version');
n = (await api('POST', `/api/notes/${c.id}/convert`, { kind: 'text' })).json;
ok(n.kind === 'text' && n.body_md.includes('~~Limes~~') && n.items.length === 0, 'checklist to text keeps checked state as strikethrough');
n = (await api('POST', `/api/notes/${c.id}/convert`, { kind: 'checklist' })).json;
ok(n.kind === 'checklist' && n.items.length === 2 && n.items[0].checked, 'text to checklist round-trips');
n = (await api('PATCH', `/api/notes/${t.id}`, { archived: true })).json;
ok(n.archived && !n.pinned, 'archive unpins');
ok((await api('GET', '/api/notes?view=archive')).json.length === 1, 'archive view');

console.log('trash');
await api('DELETE', `/api/notes/${c.id}`);
ok((await api('GET', '/api/notes?view=trash')).json.length === 1, 'trash view');
await api('POST', `/api/notes/${c.id}/restore`);
ok((await api('GET', '/api/notes?view=trash')).json.length === 0, 'restore from trash');
await api('DELETE', `/api/notes/${c.id}`);
const emptied = (await api('DELETE', '/api/notes/trash')).json;
ok(emptied.deleted === 1 && (await api('GET', `/api/notes/${c.id}`)).status === 404, 'empty trash deletes for good');

console.log('sync');
let push = (await api('POST', '/api/sync/push', { tables: {
  notes: [{ client_id: 50, title: 'From phone', kind: 'checklist', updated_at: '2026-09-13 17:00:00' }],
  labels: [{ client_id: 60, name: 'Phone label', updated_at: '2026-09-13 17:00:00' }],
  checklist_items: [{ client_id: 70, uuid: 'aaaa-1', note_id: 50, _local_fks: ['note_id'], text: 'Eggs', position: 1, updated_at: '2026-09-13 17:00:00' }],
  note_labels: [{ client_id: 80, note_id: 50, label_id: 60, _local_fks: ['note_id', 'label_id'], updated_at: '2026-09-13 17:00:00' }],
} })).json;
const phoneNoteId = push.tables.notes[0]?.server_id;
ok(phoneNoteId && push.tables.checklist_items[0]?.server_id && push.tables.note_labels[0]?.server_id, 'push new note + item + label link in one batch');
n = (await api('GET', `/api/notes/${phoneNoteId}`)).json;
ok(n.items[0]?.text === 'Eggs' && n.labels.length === 1, 'pushed rows linked correctly');

push = (await api('POST', '/api/sync/push', { tables: {
  checklist_items: [{ client_id: 71, uuid: 'aaaa-2', note_id: t.id, text: 'Intruder', updated_at: '2026-09-13 17:01:00' }],
} })).json;
ok(push.tables.checklist_items.length === 1, 'item pushed against own existing note by server id');

// Rows can't be attached to a parent that doesn't exist.
const foreign = await api('POST', '/api/sync/push', { tables: {
  checklist_items: [{ client_id: 72, uuid: 'aaaa-3', note_id: 999999, text: 'ghost', updated_at: '2026-09-13 17:01:00' }],
} });
ok(foreign.json.tables.checklist_items.length === 0, 'push to nonexistent parent is refused');

// Same uuid from a second device dedupes instead of duplicating.
push = (await api('POST', '/api/sync/push', { tables: {
  checklist_items: [{ client_id: 99, uuid: 'aaaa-1', note_id: phoneNoteId, text: 'Eggs (dozen)', position: 1, updated_at: '2026-09-13 17:05:00' }],
} })).json;
n = (await api('GET', `/api/notes/${phoneNoteId}`)).json;
ok(n.items.length === 1 && n.items[0].text === 'Eggs (dozen)', 'same uuid from another device updates, no duplicate');

// Stale write loses, and its content lands in version history.
await api('PATCH', `/api/notes/${phoneNoteId}`, { title: 'Newer on server' });
push = (await api('POST', '/api/sync/push', { tables: {
  notes: [{ client_id: 50, server_id: phoneNoteId, title: 'Stale from phone', body_md: '', kind: 'checklist', updated_at: '2020-01-01 00:00:00' }],
} })).json;
n = (await api('GET', `/api/notes/${phoneNoteId}`)).json;
versions = (await api('GET', `/api/notes/${phoneNoteId}/versions`)).json;
ok(n.title === 'Newer on server', 'older device copy does not overwrite newer server copy');
ok(versions.some(v => v.reason === 'conflict' && v.title === 'Stale from phone'), 'losing copy kept as conflict version');

const pull = (await api('GET', '/api/sync/pull?since=1970-01-01')).json;
ok(['notes', 'labels', 'checklist_items', 'note_labels'].every(k => Array.isArray(pull.tables[k])), 'pull returns all synced tables');

console.log('backup + export');
const bk = (await api('POST', '/api/full-backup')).json;
const rs = (await api('POST', `/api/full-backup/${bk.filename}/restore`)).json;
token = (await api('POST', '/api/auth/login', { username: 'admin', password: 'Phase1!Test' })).json.token;
n = (await api('GET', `/api/notes/${phoneNoteId}`)).json;
s = (await api('GET', '/api/notes?q=eggs')).json;
ok(rs.ok && n.items.length === 1 && n.labels.length === 1, 'backup restore keeps items + labels');
ok(s.length === 1, 'search index rebuilt after restore');
const ex = (await api('GET', '/api/data/export')).json;
ok(ex.checklist_items?.length >= 1 && ex.labels?.length >= 1 && Array.isArray(ex.note_versions), 'export includes new tables');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
