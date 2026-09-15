/**
 * mcp-smoke.mjs: the MCP note tools end to end against a throwaway server
 * started with MCP_ENABLED=1 MCP_WRITE_ENABLED=1 MCP_DESTROY_ENABLED=1.
 *
 *   NOTETRACE_URL=http://localhost:3004 node scripts/mcp-smoke.mjs
 */
const B = process.env.NOTETRACE_URL || 'http://localhost:3004';
let f = 0; const ok = (c, m) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) f++; };
const j = async (method, p, body, tok) => (await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();

await j('POST', '/api/auth/register', { username: 'agent', password: 'Agent!Pass99', full_name: 'Agent' });
const session = (await j('POST', '/api/auth/login', { username: 'agent', password: 'Agent!Pass99' })).token;
const mk = async (scopes) => (await j('POST', '/api/admin/api-tokens', { name: scopes.join(' '), scopes }, session)).raw;
const full = await mk(['mcp:read', 'mcp:write', 'mcp:destroy']);
const readOnly = await mk(['mcp:read']);

let rpcId = 0;
async function rpc(tok, method, params = {}) {
  const res = await fetch(`${B}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data:'));
  return JSON.parse(line ? line.slice(5) : text);
}
const call = async (tok, name, args) => {
  const r = await rpc(tok, 'tools/call', { name, arguments: args });
  const res = r.result || {};
  return { isError: !!res.isError, data: res.structuredContent, text: res.content?.[0]?.text, raw: r };
};

const toolsFull = (await rpc(full, 'tools/list')).result.tools.map(t => t.name).sort();
const toolsRead = (await rpc(readOnly, 'tools/list')).result.tools.map(t => t.name).sort();
ok(toolsFull.length === 14 && toolsFull.includes('move_to_trash') && toolsFull.includes('list_tasks'), `full token sees all 14 tools (${toolsFull.length})`);
ok(toolsRead.join() === 'get_note,list_labels,list_reminders,list_tasks,search_notes', `read token sees only read tools (${toolsRead.join()})`);

const created = await call(full, 'create_note', { title: 'Hardware store', kind: 'checklist', items: ['Wood glue', 'Sandpaper'], labels: ['Errands'] });
ok(!created.isError && created.data.note.items.length === 2 && created.data.note.labels[0] === 'Errands', 'create_note makes a labeled checklist');
const id = created.data.note.id;
const checked = await call(full, 'check_checklist_item', { id, item: 'glue' });
ok(!checked.isError && checked.data.item === 'Wood glue', 'check_checklist_item finds an item by partial text');
const due = await call(full, 'set_due_date', { id, item: 'sandpaper', due: '2099-01-02' });
ok(!due.isError && due.data.due === '2099-01-02', 'set_due_date dates an item');
const tasks = await call(readOnly, 'list_tasks', { due_by: '2099-12-31' });
ok(!tasks.isError && tasks.data.tasks.length === 1 && tasks.data.tasks[0].text === 'Sandpaper' && tasks.data.tasks[0].due === '2099-01-02', 'list_tasks returns dated open items');
const found = await call(readOnly, 'search_notes', { query: 'sandpaper' });
ok(found.data.count === 1 && found.data.notes[0].open_items[0] === 'Sandpaper', 'search_notes finds it with open items');
const rem = await call(full, 'set_reminder', { id, at: '2099-05-01T09:00:00Z', repeat: 'monthly' });
ok(!rem.isError && rem.data.reminder.repeat === 'monthly', 'set_reminder with an ISO time');
const noConfirm = await call(full, 'move_to_trash', { id });
ok(noConfirm.isError || !!noConfirm.raw.error, 'move_to_trash without confirm is refused');
const trashed = await call(full, 'move_to_trash', { id, confirm: true });
ok(!trashed.isError && trashed.data.ok, 'move_to_trash with confirm=true');
const gone = await call(readOnly, 'get_note', { id });
ok(!gone.isError && gone.data.trashed === true, 'trashed note reads as trashed (restorable for 30 days)');

console.log(f ? `${f} FAILED` : 'all passed');
process.exit(f ? 1 : 0);
