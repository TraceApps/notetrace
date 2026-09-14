/**
 * cooktrace-smoke.mjs: link CookTrace and send checklist items, against a
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
ok(r.status === 400 && /mcp:write/.test(r.data.error), `read-only token is refused (${r.data.error})`);
r = await j('PUT', '/api/integrations/cooktrace', { url: CT, token: 'ct-nowrite' }, tok);
ok(r.status === 400 && /MCP_WRITE_ENABLED/.test(r.data.error), `writes off on CookTrace is explained (${r.data.error})`);
r = await j('PUT', '/api/integrations/cooktrace', { url: 'not a url', token: 'ct-write' }, tok);
ok(r.status === 400, 'bad address is refused');
r = await j('POST', '/api/integrations/cooktrace/shopping', { items: ['Eggs'] }, tok);
ok(r.status === 409, 'sending before linking asks to link first');

r = await j('PUT', '/api/integrations/cooktrace', { url: CT + '/', token: 'ct-write' }, tok);
ok(r.status === 200 && r.data.connected && r.data.username === 'chef' && r.data.url === CT, 'links with a good token');
ok(!JSON.stringify(r.data).includes('ct-write'), 'the token is not sent back');
const settings = (await j('GET', '/api/settings', null, tok)).data;
ok(!Object.keys(settings).some(k => /cooktrace/i.test(k)), 'the link is not in client settings');
const pull = (await j('GET', '/api/sync/pull?since=0', null, tok)).data;
ok(!JSON.stringify(pull).includes('cooktraceToken'), 'the link is not in sync pulls');
await j('POST', '/api/sync/push', { tables: {}, settings: [{ key: 'cooktraceUrl', value: 'http://evil.example', updated_at: '2099-01-01 00:00:00' }] }, tok);
ok((await j('GET', '/api/integrations/cooktrace', null, tok)).data.url === CT, 'sync pushes can\'t overwrite the link');
const exp = (await j('GET', '/api/data/export', null, tok)).data;
ok(!JSON.stringify(exp).includes('cooktraceToken'), 'the link is not in the data export');

r = await j('POST', '/api/integrations/cooktrace/shopping', { items: [
  { text: 'Eggs', checked: false }, { text: 'Milk', checked: true }, { text: 'eggs', checked: false }, { text: '**Flour**', checked: false },
] }, tok);
ok(r.status === 200 && r.data.added === 2 && r.data.failed === 0, `sends unchecked items once (${JSON.stringify(r.data)})`);
let got = await (await fetch(`${FAKE}/__items`)).json();
ok(got.join() === 'Eggs,Flour', `CookTrace got them (${got.join()})`);

r = await j('POST', '/api/integrations/cooktrace/shopping', { items: ['Butter', 'Fail here', 'Salt'] }, tok);
ok(r.status === 200 && r.data.added === 1 && r.data.failed === 2 && r.data.error, `a refused item stops the send and reports it (${JSON.stringify(r.data)})`);
r = await j('POST', '/api/integrations/cooktrace/shopping', { items: [{ text: 'Done', checked: true }] }, tok);
ok(r.status === 400, 'nothing unchecked is a 400');

// Another user can't see or use this link.
const inv = (await j('POST', '/api/auth/invite', { role: 'user' }, tok)).data;
const invToken = new URL(inv.inviteUrl.replace('/#/', '/')).searchParams.get('token');
await j('POST', '/api/auth/accept-invite', { token: invToken, username: 'other', password: 'Other!Pass99', full_name: 'Other' });
const other = (await j('POST', '/api/auth/login', { username: 'other', password: 'Other!Pass99' })).data.token;
ok((await j('GET', '/api/integrations/cooktrace', null, other)).data.connected === false, 'links are per user');

r = await j('DELETE', '/api/integrations/cooktrace', null, tok);
ok(r.data.connected === false && (await j('GET', '/api/integrations/cooktrace', null, tok)).data.connected === false, 'unlinks');

console.log(f ? `${f} FAILED` : 'all passed');
process.exit(f ? 1 : 0);
