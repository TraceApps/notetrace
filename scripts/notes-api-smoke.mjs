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

console.log('reminders');
let rn = (await api('POST', '/api/notes', { title: 'Call dentist', body_md: 'x' })).json;
let r = (await api('PATCH', `/api/notes/${rn.id}`, { reminder_at: '2030-05-01T14:00:00.000Z', reminder_rrule: 'weekly', reminder_tz: 'America/New_York' })).json;
ok(r.reminder_at === '2030-05-01 14:00:00' && r.reminder_rrule === 'weekly' && r.reminder_tz === 'America/New_York', 'reminder saved as UTC with repeat and zone');
r = (await api('PATCH', `/api/notes/${rn.id}`, { reminder_rrule: 'hourly', reminder_tz: 'Not/AZone' })).json;
ok(r.reminder_rrule === null && r.reminder_tz === null, 'unknown repeat and zone are dropped');
const rnoAt = (await api('POST', '/api/notes', { title: 'No time' })).json;
r = (await api('PATCH', `/api/notes/${rnoAt.id}`, { reminder_rrule: 'daily' })).json;
ok(r.reminder_rrule === null, 'repeat without a reminder time is ignored');
let rl = (await api('GET', '/api/notes?view=reminders')).json;
ok(rl.some(x => x.id === rn.id) && !rl.some(x => x.id === rnoAt.id), 'reminders view lists only notes with a reminder');
r = (await api('PATCH', `/api/notes/${rn.id}`, { reminder_at: null })).json;
ok(r.reminder_at === null && r.reminder_rrule === null && r.reminder_tz === null, 'clearing the time clears repeat and zone');
const sh = await fetch(`${B}/share-target?title=Hi&text=Some%20text&url=https%3A%2F%2Fexample.com`, { redirect: 'manual' });
ok(sh.status === 303 && /#\/\?share=1&title=Hi&text=Some\+text&url=https/.test(sh.headers.get('location') || ''), 'share target redirects into the app');

console.log('sharing');
const inv = (await api('POST', '/api/auth/invite', { role: 'user' })).json;
const invToken = new URL(inv.inviteUrl.replace('/#/', '/')).searchParams.get('token');
await api('POST', '/api/auth/accept-invite', { token: invToken, username: 'sam', password: 'Share!Test9', full_name: 'Sam' });
const ownerToken = token;
const samToken = (await api('POST', '/api/auth/login', { username: 'sam', password: 'Share!Test9' })).json.token;
const as = async (tok, ...a) => { const prev = token; token = tok; try { return await api(...a); } finally { token = prev; } };
ok(!!samToken, 'second account signs in');

const shared = (await api('POST', '/api/notes', { title: 'Trip packing', kind: 'checklist', items: [{ text: 'Passport' }] })).json;
await api('PATCH', `/api/notes/${shared.id}`, { reminder_at: '2031-01-01T10:00:00Z' });
let pullSince = (await as(samToken, 'GET', '/api/sync/pull?since=1970-01-01')).json.now;
ok((await as(samToken, 'GET', `/api/notes/${shared.id}`)).status === 404, 'unshared note is private');
let addRes = await api('POST', `/api/notes/${shared.id}/members`, { username: 'nobody' });
ok(addRes.status === 404, 'sharing with an unknown username fails');
addRes = await api('POST', `/api/notes/${shared.id}/members`, { username: 'SAM', role: 'edit' });
ok(addRes.status === 200 && addRes.json.members.length === 1 && addRes.json.members[0].role === 'edit', 'owner shares with edit access');

let samView = (await as(samToken, 'GET', `/api/notes/${shared.id}`)).json;
ok(samView.share_role === 'edit' && samView.share_owner === 'Admin' && samView.reminder_at === null, 'member sees note with role and owner, no reminder');
ok((await as(samToken, 'GET', '/api/notes')).json.some(x => x.id === shared.id), 'shared note is in the member list');
const pull1 = (await as(samToken, 'GET', `/api/sync/pull?since=${encodeURIComponent(pullSince)}`)).json;
ok(pull1.tables.notes.some(x => x.id === shared.id && x.share_role === 'edit') && pull1.tables.checklist_items.some(i => i.note_id === shared.id), 'member device pulls the shared note and its items');

await as(samToken, 'POST', `/api/notes/${shared.id}/items`, { text: 'Charger' });
await as(samToken, 'PATCH', `/api/notes/${shared.id}`, { pinned: true, title: 'Trip packing list', reminder_at: '2035-01-01T00:00:00Z' });
let ownerView = (await api('GET', `/api/notes/${shared.id}`)).json;
ok(ownerView.items.length === 2 && ownerView.title === 'Trip packing list', 'edit member changes title and items');
ok(ownerView.pinned === false && ownerView.reminder_at === '2031-01-01 10:00:00' && ownerView.share_count === 1, 'member pin is personal and cannot change the reminder');
ok((await as(samToken, 'GET', `/api/notes/${shared.id}`)).json.pinned === true, 'member sees their own pin');
ok((await as(samToken, 'DELETE', `/api/notes/${shared.id}`)).status === 404, 'member cannot trash the note');

const samLabel = (await as(samToken, 'POST', '/api/labels', { name: 'Travel' })).json;
await as(samToken, 'PATCH', `/api/notes/${shared.id}`, { labels: [samLabel.id] });
ok((await api('GET', `/api/notes/${shared.id}`)).json.labels.length === 0 && (await as(samToken, 'GET', `/api/notes/${shared.id}`)).json.labels.length === 1, 'labels on a shared note are personal');

await api('PATCH', `/api/notes/${shared.id}/members/${addRes.json.members[0].user_id}`, { role: 'view' });
const viewPatch = (await as(samToken, 'PATCH', `/api/notes/${shared.id}`, { title: 'Hijacked' })).json;
ok(viewPatch.title === 'Trip packing list' && (await as(samToken, 'POST', `/api/notes/${shared.id}/items`, { text: 'x' })).status === 404, 'view member cannot edit');

// Member device pushes: view role content is rejected, pin still applies.
let push2 = (await as(samToken, 'POST', '/api/sync/push', { tables: { notes: [{ client_id: 9, server_id: shared.id, title: 'Pushed title', pinned: 0, updated_at: '2099-01-01 00:00:00' }] } })).json;
ok(push2.tables.notes[0]?.server_id === shared.id && (await api('GET', `/api/notes/${shared.id}`)).json.title === 'Trip packing list', 'view member push is acked but content ignored');
await api('PATCH', `/api/notes/${shared.id}/members/${addRes.json.members[0].user_id}`, { role: 'edit' });
push2 = (await as(samToken, 'POST', '/api/sync/push', { tables: {
  notes: [{ client_id: 9, server_id: shared.id, title: 'Packing (synced)', updated_at: '2099-01-01 00:00:00' }],
  checklist_items: [{ client_id: 3, uuid: 'shared-item-uuid-1', note_id: shared.id, text: 'Socks', checked: 0, position: 9, updated_at: '2099-01-01 00:00:00' }],
} })).json;
ownerView = (await api('GET', `/api/notes/${shared.id}`)).json;
ok(ownerView.title === 'Packing (synced)' && ownerView.items.some(i => i.text === 'Socks'), 'edit member push updates content and adds items');
const ownerPull = (await api('GET', '/api/sync/pull?since=1970-01-01')).json;
ok(ownerPull.tables.checklist_items.some(i => i.uuid === 'shared-item-uuid-1'), 'owner device pulls items a member added');

pullSince = (await as(samToken, 'GET', '/api/sync/pull?since=1970-01-01')).json.now;
const left = await as(samToken, 'DELETE', `/api/notes/${shared.id}/members/${addRes.json.members[0].user_id}`);
const pull2 = (await as(samToken, 'GET', `/api/sync/pull?since=${encodeURIComponent(pullSince)}`)).json;
ok(left.status === 200 && pull2.revoked_notes.includes(shared.id), 'leaving revokes the note on member devices');
ok((await as(samToken, 'GET', `/api/notes/${shared.id}`)).status === 404 && (await api('GET', `/api/notes/${shared.id}`)).json.share_count === 0, 'after leaving, member has no access');

await api('POST', `/api/notes/${shared.id}/members`, { username: 'sam' });
pullSince = (await as(samToken, 'GET', '/api/sync/pull?since=1970-01-01')).json.now;
await api('DELETE', `/api/notes/${shared.id}`);
const pull3 = (await as(samToken, 'GET', `/api/sync/pull?since=${encodeURIComponent(pullSince)}`)).json;
ok(pull3.revoked_notes.includes(shared.id) && (await as(samToken, 'GET', '/api/notes')).json.every(x => x.id !== shared.id), 'owner trashing hides it from members');
await api('POST', `/api/notes/${shared.id}/restore`);
ok((await as(samToken, 'GET', `/api/notes/${shared.id}`)).status === 200, 'restoring brings it back for members');

console.log('import');
const importBatch = [
  { title: 'From Keep', body_md: 'Line one  \nline two', kind: 'text', color: 'tide', pinned: true, labels: ['Imported', 'home'], created_at: '2024-09-10 20:26:40', updated_at: '2024-09-12 14:06:40' },
  { title: 'Keep list', kind: 'checklist', items: [{ text: 'Limes', checked: false }, { text: 'Rice', checked: true }], archived: true, created_at: '2024-09-11 08:00:00' },
  { title: '', body_md: '', kind: 'text' },
];
let imp = (await api('POST', '/api/notes/import', { notes: importBatch })).json;
ok(imp.imported === 2 && imp.skipped === 1 && imp.labels_created === 1, `import saves notes, skips empty ones, reuses labels by name (${JSON.stringify(imp)})`);
const impNote = (await api('GET', '/api/notes?q=keep')).json.find(x => x.title === 'From Keep');
ok(impNote && impNote.created_at === '2024-09-10 20:26:40' && impNote.updated_at === '2024-09-12 14:06:40' && impNote.pinned && impNote.labels.length === 2, 'imported note keeps dates, pin, and labels');
const impList = (await api('GET', '/api/notes?view=archive')).json.find(x => x.title === 'Keep list');
ok(impList && impList.items.length === 2 && impList.items[1].checked, 'imported checklist lands in Archive with checked state');
imp = (await api('POST', '/api/notes/import', { notes: importBatch })).json;
ok(imp.imported === 0 && imp.skipped === 3, 'importing the same notes again adds nothing');
ok((await api('POST', '/api/notes/import', { notes: 'nope' })).status === 400, 'import rejects a non-array body');

console.log('backup + export');
const bk = (await api('POST', '/api/full-backup')).json;
const rs = (await api('POST', `/api/full-backup/${bk.filename}/restore`)).json;
token = (await api('POST', '/api/auth/login', { username: 'admin', password: 'Phase1!Test' })).json.token;
n = (await api('GET', `/api/notes/${phoneNoteId}`)).json;
s = (await api('GET', '/api/notes?q=eggs')).json;
ok(rs.ok && n.items.length === 1 && n.labels.length === 1, 'backup restore keeps items + labels');
ok(s.length === 1, 'search index rebuilt after restore');
ok((await api('GET', `/api/notes/${shared.id}/members`)).json.members?.length === 1, 'backup restore keeps who notes are shared with');
const ex = (await api('GET', '/api/data/export')).json;
ok(ex.checklist_items?.length >= 1 && ex.labels?.length >= 1 && Array.isArray(ex.note_versions), 'export includes new tables');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
