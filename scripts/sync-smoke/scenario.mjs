import * as A from './.build/devA/device.mjs';
import * as B from './.build/devB/device.mjs';
import * as C from './.build/devC/device.mjs';
const B_URL = process.env.NOTETRACE_URL || 'http://localhost:3004';
let f = 0; const ok = (c, m) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) f++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = async (p, body, tok) => (await fetch(B_URL + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) })).json();
const get = async (p, tok) => (await fetch(B_URL + p, { headers: { Authorization: 'Bearer ' + tok } })).json();
await post('/api/auth/register', { username: 'sync', password: 'Sync!Test1', full_name: 'Sync' });
const tok = (await post('/api/auth/login', { username: 'sync', password: 'Sync!Test1' })).token;
A.setToken(tok); B.setToken(tok);
await A.dbInit(); await B.dbInit();
const sync = async d => { await d.pullChanges(); await d.pushChanges(); await d.pullChanges(); };

// 1. Device A creates a labeled checklist offline, then syncs.
const label = await A.N.createLabel({ name: 'Home', icon: 'home' });
let na = await A.N.createNote({ title: 'Groceries', kind: 'checklist', items: [{ text: 'Limes' }, { text: 'Rice' }], labels: [label.id] });
await sync(A);
let server = await get('/api/notes', tok);
ok(server.length === 1 && server[0].items.length === 2 && server[0].labels.length === 1, 'A: new note + items + label link reach server in one push');

// 2. Device B pulls it down.
await sync(B);
let nb = (await B.N.getNotes())[0];
const bLabels = await B.N.getLabels();
ok(nb && nb.items.length === 2 && nb.labels.length === 1 && nb.labels[0] === bLabels[0].id, 'B: pulled note has items and the label mapped to its local id');
ok(bLabels[0].icon === 'home', 'B: the label icon syncs');
await A.N.updateNote(na.id, { in_tasks: true });
await sync(A);
await sync(B);
ok((await B.N.getNotes()).find(n => n.title === 'Groceries')?.in_tasks === true, 'B: Show in Tasks syncs');

// 3. Concurrent offline item edits on both devices.
const limes = na.items.find(i => i.text === 'Limes').uuid;
const rice = nb.items.find(i => i.text === 'Rice').uuid;
await sleep(1100);
await A.N.updateItem(na.id, limes, { checked: true });
await B.N.addItem(nb.id, { text: 'Cilantro' });
await B.N.deleteItem(nb.id, rice);
await sync(A); await sync(B); await sync(A);
server = (await get('/api/notes', tok))[0];
na = await A.N.getNote(na.id); nb = await B.N.getNote(nb.id);
const summary = n => n.items.map(i => `${i.text}${i.checked ? '+' : ''}`).sort().join(',');
ok(summary(server) === 'Cilantro,Limes+', `server merged item edits from both devices (${summary(server)})`);
ok(summary(na) === summary(server) && summary(nb) === summary(server), `both devices converge (${summary(na)} / ${summary(nb)})`);

// 4. Conflicting title edits: B's newer edit wins everywhere, A's is kept as a version.
await sleep(1100);
await A.N.updateNote(na.id, { title: 'Groceries (A)' });
await sleep(1100);
await B.N.updateNote(nb.id, { title: 'Groceries (B)' });
await sync(B); await sync(A); await sync(B);
server = (await get('/api/notes', tok))[0];
na = await A.N.getNote(na.id); nb = await B.N.getNote(nb.id);
ok(server.title === 'Groceries (B)' && na.title === 'Groceries (B)' && nb.title === 'Groceries (B)', 'newer title wins on server and both devices');
const versions = await get(`/api/notes/${server.id}/versions`, tok);
ok(versions.some(v => v.title === 'Groceries (A)'), 'losing title kept in server version history');

// 5. Label removal and trash sync.
await sleep(1100);
await B.N.updateNote(nb.id, { labels: [] });
await sync(B); await sync(A);
na = await A.N.getNote(na.id);
ok(na.labels.length === 0, 'label removal syncs to the other device');
await sleep(1100);
await A.N.trashNote(na.id);
await sync(A); await sync(B);
ok((await B.N.getNotes({ view: 'trash' })).length === 1, 'trash syncs to the other device');
await sleep(1100);
await B.N.emptyTrash();
await sync(B); await sync(A);
ok((await A.N.getNotes({ view: 'trash' })).length === 0 && (await get('/api/notes?view=trash', tok)).length === 0, 'permanent delete syncs everywhere');

// 6. Sharing: a second account's device receives, edits, and loses a shared note.
const req = async (method, p, body, t) => (await fetch(B_URL + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: body ? JSON.stringify(body) : undefined })).json();
const inv = await req('POST', '/api/auth/invite', { role: 'user' }, tok);
await post('/api/auth/accept-invite', { token: new URL(inv.inviteUrl.replace('/#/', '/')).searchParams.get('token'), username: 'sam', password: 'Share!Sync7', full_name: 'Sam' });
const samTok = (await post('/api/auth/login', { username: 'sam', password: 'Share!Sync7' })).token;
C.setToken(samTok); await C.dbInit();
await sync(C);
ok((await C.N.getNotes()).length === 0, 'C: second account starts with no notes');

let shared = await A.N.createNote({ title: 'Camping list', kind: 'checklist', items: [{ text: 'Tent' }] });
await sync(A);
const sharedServer = (await get('/api/notes', tok)).find(n => n.title === 'Camping list');
await req('POST', `/api/notes/${sharedServer.id}/members`, { username: 'sam', role: 'edit' }, tok);
await sync(C);
let nc = (await C.N.getNotes()).find(n => n.title === 'Camping list');
ok(nc && nc.share_role === 'edit' && nc.share_owner === 'Sync' && nc.items.length === 1, `C: shared note arrives with role and items (${nc?.share_role}, owner ${nc?.share_owner})`);

await sleep(1100);
await C.N.addItem(nc.id, { text: 'Lantern' });
await C.N.updateNote(nc.id, { pinned: true });
await sync(C); await sync(A);
shared = await A.N.getNote(shared.id);
ok(shared.items.map(i => i.text).sort().join(',') === 'Lantern,Tent', 'A: owner device gets the item the member added offline');
ok(!shared.pinned && shared.share_count === 1, 'A: member pin stays personal; owner sees it is shared with one person');

await req('DELETE', `/api/notes/${sharedServer.id}/members/${(await req('GET', `/api/notes/${sharedServer.id}/members`, null, tok)).members[0].user_id}`, null, tok);
await sync(C);
ok(!(await C.N.getNotes()).some(n => n.title === 'Camping list'), 'C: removed member device drops the note');
await sync(A);
ok((await A.N.getNote(shared.id)).share_count === 0, 'A: owner device sees the note is no longer shared');

// 7. Local-mode import (on-device) and its sync up to the server.
const localImp = await A.N.importNotes([
  { title: 'Imported offline', body_md: 'From a Keep export', kind: 'text', labels: ['Keep import'], created_at: '2023-05-01 09:00:00', updated_at: '2023-05-02 10:00:00' },
  { title: 'Imported offline', body_md: 'From a Keep export', kind: 'text', created_at: '2023-05-01 09:00:00' },
]);
ok(localImp.imported === 1 && localImp.skipped === 1 && localImp.labels_created === 1, `A: on-device import skips the repeat (${JSON.stringify(localImp)})`);
await sync(A);
const impServer = (await get('/api/notes', tok)).find(n => n.title === 'Imported offline');
ok(impServer && impServer.labels.length === 1 && impServer.updated_at === '2023-05-02 10:00:00', 'A: imported note and its label sync to the server with its date');

// 8. On-device trash purge after 30 days.
const oldNote = await B.N.createNote({ title: 'Old trash', body_md: 'x' });
await B.N.trashNote(oldNote.id);
const { getDb: getDbB } = await import('./.build/devB/db-native.mjs');
await (await getDbB()).run(`UPDATE notes SET trashed_at = '2020-01-01 00:00:00' WHERE id = ?`, [oldNote.id]);
const purged = await B.N.purgeExpiredTrash();
ok(purged === 1 && !(await B.N.getNotes({ view: 'trash' })).some(n => n.id === oldNote.id), 'B: notes trashed over 30 days ago are purged on the device');

// 9. Images sync between devices, removals too; device-local paths wait for upload.
let pic = await A.N.createNote({ title: 'Paint colors', body_md: 'Hallway' , attachments: [{ uuid: 'img-uuid-1', url: '/uploads/swatch.png', mime: 'image/png', width: 40, height: 30 }] });
await A.N.addAttachments(pic.id, [{ uuid: 'img-uuid-2', url: 'https://localhost/_capacitor_file_/data/user/0/com.notetrace.app/files/uploads/local.jpg', mime: 'image/jpeg' }]);
await sync(A); await sync(B);
let picB = (await B.N.getNotes()).find(n => n.title === 'Paint colors');
ok(picB && picB.attachments.length === 1 && picB.attachments[0].uuid === 'img-uuid-1' && picB.attachments[0].width === 40, `B: uploaded image syncs, device-local one waits (${picB?.attachments.map(a => a.uuid)})`);
await sleep(1100);
await B.N.deleteAttachment(picB.id, 'img-uuid-1');
await sync(B); await sync(A);
pic = await A.N.getNote(pic.id);
ok(!pic.attachments.some(a => a.uuid === 'img-uuid-1'), 'A: image removed on B is gone on A');

// 10. [[Links]] on the device: find by title, backlinks, rename updates links.
const tgt = await A.N.createNote({ title: 'Reading list' });
const src = await A.N.createNote({ title: 'Plans', body_md: 'Check [[reading list]]' });
ok((await A.N.findNoteByTitle('READING LIST'))?.id === tgt.id && (await A.N.getBacklinks(tgt.id)).some(b => b.id === src.id), 'A: local find-by-title and backlinks');
await A.N.updateNote(tgt.id, { title: 'Books to read' });
ok((await A.N.getNote(src.id)).body_md === 'Check [[Books to read]]', 'A: renaming updates links in local notes');

// 11. Repeating tasks: the repeat travels, and a tick on one device moves the date on everywhere.
const chores = await A.N.createNote({ title: 'Chores', kind: 'checklist', items: [{ text: 'Bins out', due_date: '2026-09-15', due_repeat: 'weekly' }] });
await sync(A); await sync(B);
let choresB = (await B.N.getNotes()).find(n => n.title === 'Chores');
ok(choresB?.items[0]?.due_repeat === 'weekly' && choresB.items[0].due_date === '2026-09-15', 'B: a repeating task arrives with its repeat');
await sleep(1100);
await B.N.updateItem(choresB.id, choresB.items[0].uuid, { checked: true, today: '2026-09-15' });
await sync(B); await sync(A);
const choresA = await A.N.getNote(chores.id);
ok(choresA.items[0].checked === false && choresA.items[0].due_date === '2026-09-22', `A: ticking it on B moved it on for A too (${choresA.items[0].due_date})`);
await sleep(1100);
const mop = await A.N.addItem(chores.id, { text: 'Mop' });
const mopItem = mop.items.find(i => i.text === 'Mop');
await A.N.updateItem(chores.id, mopItem.uuid, { checked: true });
await sync(A); await sync(B);
choresB = await B.N.getNote(choresB.id);
ok(!!choresB.items.find(i => i.text === 'Mop')?.checked_at, 'B: when an item was ticked syncs too, for Completed');

console.log(f ? `${f} FAILED` : 'all passed'); process.exit(f ? 1 : 0);
