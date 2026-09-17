/**
 * cooktrace-smoke.mjs: link CookTrace, send checklist items, and use its
 * shopping list (list, check off, clear) through NoteTrace, against a
 * throwaway NoteTrace (ALLOW_PRIVATE_COOKTRACE_URLS=1) and the stand-in
 * CookTrace in design/tools/fake-cooktrace.mjs.
 *
 *   NOTETRACE_URL=http://localhost:3004 COOKTRACE_URL=http://host.docker.internal:5998 \
 *   FAKE_URL=http://localhost:5998 node scripts/cooktrace-smoke.mjs
 */
const B = process.env.NOTETRACE_URL || 'http://localhost:3004';
const CT = process.env.COOKTRACE_URL || 'http://host.docker.internal:5998';
const FAKE = process.env.FAKE_URL || 'http://localhost:5998';
let f = 0; const ok = (c, m) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) f++; };
async function j(method, p, body, tok) {
  const res = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

await fetch(`${FAKE}/__reset`);
await j('POST', '/api/auth/register', { username: 'cook', password: 'Cook!Pass99', full_name: 'Cook' });
const tok = (await j('POST', '/api/auth/login', { username: 'cook', password: 'Cook!Pass99' })).data.token;

ok((await j('GET', '/api/integrations/cooktrace', null, tok)).data.connected === false, 'starts unlinked');
let r = await j('PUT', '/api/integrations/cooktrace', { url: CT, token: 'wrong' }, tok);
ok(r.status === 400 && /accept/i.test(r.data.error), `bad token is refused (${r.data.error})`);
r = await j('PUT', '/api/integrations/cooktrace', { url: CT, token: 'ct-read' }, tok);
ok(r.status === 400 && /shopping scope/.test(r.data.error), `a token without the shopping scope is refused (${r.data.error})`);
r = await j('PUT', '/api/integrations/cooktrace', { url: CT, token: 'ct-old' }, tok);
ok(r.status === 400 && /too old/.test(r.data.error), `a CookTrace without the shopping API is explained (${r.data.error})`);
r = await j('PUT', '/api/integrations/cooktrace', { url: 'not a url', token: 'ct-shop' }, tok);
ok(r.status === 400, 'bad address is refused');
r = await j('POST', '/api/integrations/cooktrace/shopping', { items: ['Eggs'] }, tok);
ok(r.status === 409, 'sending before linking asks to link first');

r = await j('PUT', '/api/integrations/cooktrace', { url: CT + '/', token: 'ct-shop' }, tok);
ok(r.status === 200 && r.data.connected && r.data.username === 'chef' && r.data.url === CT, 'links with a good token');
ok(!JSON.stringify(r.data).includes('ct-shop'), 'the token is not sent back');
ok(r.data.enabled === true, 'linking switches it on');
r = await j('PUT', '/api/integrations/cooktrace', { url: CT }, tok);
ok(r.status === 200 && r.data.connected, 'saving the same address keeps the saved token');
r = await j('PUT', '/api/integrations/cooktrace', { url: 'http://host.docker.internal:5997' }, tok);
ok(r.status === 400 && /again for the new address/.test(r.data.error), `a new address needs the token again (${r.data.error})`);
ok((await j('GET', '/api/integrations/cooktrace', null, tok)).data.url === CT, 'and the saved link is untouched');
r = await j('POST', '/api/integrations/cooktrace/test', {}, tok);
ok(r.status === 200 && r.data.connected && r.data.username === 'chef', 'Test checks the saved link');
r = await j('PATCH', '/api/integrations/cooktrace', { enabled: false }, tok);
ok(r.data.connected === true && r.data.enabled === false, 'switching off keeps the link');
r = await j('PATCH', '/api/integrations/cooktrace', { enabled: true }, tok);
ok(r.data.enabled === true, 'and back on');
const settings = (await j('GET', '/api/settings', null, tok)).data;
ok(!Object.keys(settings).some(k => /cooktrace/i.test(k)), 'the link is not in client settings');
const pull = (await j('GET', '/api/sync/pull?since=0', null, tok)).data;
ok(!JSON.stringify(pull).includes('cooktraceToken'), 'the link is not in sync pulls');
await j('POST', '/api/sync/push', { tables: {}, settings: [{ key: 'cooktraceUrl', value: 'http://evil.example', updated_at: '2099-01-01 00:00:00' }] }, tok);
ok((await j('GET', '/api/integrations/cooktrace', null, tok)).data.url === CT, 'sync pushes can\'t overwrite the link');
const exp = (await j('GET', '/api/data/export', null, tok)).data;
ok(!JSON.stringify(exp).includes('cooktraceToken'), 'the link is not in the data export');

await fetch(`${FAKE}/__empty`);
r = await j('POST', '/api/integrations/cooktrace/shopping', { items: [
  { text: 'oat milk', checked: false }, { text: 'Milk', checked: true }, { text: 'Oat Milk', checked: false }, { text: '**Flour**', checked: false },
] }, tok);
ok(r.status === 200 && r.data.added.length === 2 && r.data.skipped.length === 0, `sends unchecked items once, in one call (${JSON.stringify(r.data)})`);
let got = await (await fetch(`${FAKE}/__items`)).json();
ok(got.map(i => i.name).sort().join() === 'Flour,Oat Milk', `CookTrace got them (${got.map(i => i.name).join()})`);
ok(r.data.added.find(i => i.name === 'Oat Milk')?.aisle === 'Dairy & Eggs', 'CookTrace gave the pantry item its aisle');
r = await j('POST', '/api/integrations/cooktrace/shopping', { items: ['OAT MILK', 'Salt'] }, tok);
ok(r.status === 200 && r.data.added.length === 1 && r.data.skipped.length === 1, 'an item already on the CookTrace list is skipped');
r = await j('POST', '/api/integrations/cooktrace/shopping', { items: [{ text: 'Done', checked: true }] }, tok);
ok(r.status === 400, 'nothing unchecked is a 400');

// The list, as NoteTrace shows it.
await fetch(`${FAKE}/__reset`);
r = await j('GET', '/api/integrations/cooktrace/shopping', null, tok);
const list = r.data.items || [];
ok(r.status === 200 && list.length === 5 && list.at(-1).checked === true, `lists the CookTrace shopping list, checked last (${list.map(i => i.name).join(', ')})`);
ok(list[0].aisle === 'Bakery' && list.find(i => i.name === 'Limes').recipe_name === 'Fish Tacos', 'with aisles and recipes');
const limes = list.find(i => i.name === 'Limes');
r = await j('PATCH', `/api/integrations/cooktrace/shopping/${limes.id}`, { checked: true }, tok);
ok(r.status === 200 && r.data.checked === true, 'checks an item off');
got = await (await fetch(`${FAKE}/__items`)).json();
ok(got.find(i => i.name === 'Limes').checked === true, 'CookTrace has it checked');
r = await j('PATCH', '/api/integrations/cooktrace/shopping/9999', { checked: true }, tok);
ok(r.status === 404, 'an item that is gone is a 404');
r = await j('PATCH', '/api/integrations/cooktrace/shopping/abc', { checked: true }, tok);
ok(r.status === 400, 'a bad id is a 400');
r = await j('DELETE', '/api/integrations/cooktrace/shopping/checked', null, tok);
ok(r.status === 200 && r.data.removed === 2, `clears checked items (${JSON.stringify(r.data)})`);

// Another user can't see or use this link.
const inv = (await j('POST', '/api/auth/invite', { role: 'user' }, tok)).data;
const invToken = new URL(inv.inviteUrl.replace('/#/', '/')).searchParams.get('token');
await j('POST', '/api/auth/accept-invite', { token: invToken, username: 'other', password: 'Other!Pass99', full_name: 'Other' });
const other = (await j('POST', '/api/auth/login', { username: 'other', password: 'Other!Pass99' })).data.token;
ok((await j('GET', '/api/integrations/cooktrace', null, other)).data.connected === false, 'links are per user');
ok((await j('GET', '/api/integrations/cooktrace/shopping', null, other)).status === 409, 'and another user can\'t read the list');

r = await j('DELETE', '/api/integrations/cooktrace', null, tok);
ok(r.data.connected === false && (await j('GET', '/api/integrations/cooktrace', null, tok)).data.connected === false, 'unlinks');

console.log(f ? `${f} FAILED` : 'all passed');
process.exit(f ? 1 : 0);
