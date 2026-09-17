/**
 * backup-restore-smoke.mjs: make a full backup, change everything, restore it,
 * and check the data comes back. Run against a throwaway NoteTrace.
 *
 *   NOTETRACE_URL=http://localhost:3004 node scripts/backup-restore-smoke.mjs
 */
const B = process.env.NOTETRACE_URL || 'http://localhost:3004';
let f = 0; const ok = (c, m) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) f++; };

async function j(method, p, body, tok) {
  const res = await fetch(B + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

await j('POST', '/api/auth/register', { username: 'backupadmin', password: 'Backup!Pass9', full_name: 'Backup' });
const tok = (await j('POST', '/api/auth/login', { username: 'backupadmin', password: 'Backup!Pass9' })).data.token;

// Something of every kind that should survive a restore.
const note = (await j('POST', '/api/notes', { title: 'Keep me', body_md: 'Body that must come back', kind: 'text' }, tok)).data;
const list = (await j('POST', '/api/notes', { title: 'Shopping', kind: 'checklist' }, tok)).data;
await j('POST', `/api/notes/${list.id}/items`, { text: 'Milk' }, tok);
const label = (await j('POST', '/api/labels', { name: 'Home/Garage', color: 'mint', icon: 'home' }, tok)).data;
await j('PATCH', `/api/notes/${note.id}`, { labels: [label.id] }, tok);
await j('PUT', '/api/settings/bulk', { settings: { labelOrder: 'custom', accentColor: 'mint' } }, tok);
const apiToken = (await j('POST', '/api/admin/api-tokens', { name: 'For scripts', scopes: ['mcp:read'] }, tok)).data;
const hook = (await j('POST', '/api/admin/webhooks', { url: 'https://example.com/notetrace-hook', events: ['note.created'] }, tok)).data;
ok(!!apiToken?.token, `made an API token (${apiToken.error || 'ok'})`);
ok(!!hook?.webhook, `made a webhook (${hook.error || 'ok'})`);

const made = await j('POST', '/api/full-backup', {}, tok);
ok(made.status === 200 && made.data.filename, `made a backup (${made.data.filename || made.data.error})`);

// Wreck everything the backup should bring back.
await j('DELETE', `/api/notes/${note.id}`, null, tok);
await j('DELETE', `/api/labels/${label.id}`, null, tok);
await j('PUT', '/api/settings/bulk', { settings: { labelOrder: 'alpha', accentColor: 'lavender' } }, tok);
for (const t of (await j('GET', '/api/admin/api-tokens', null, tok)).data.tokens || []) await j('DELETE', `/api/admin/api-tokens/${t.id}`, null, tok);
for (const w of (await j('GET', '/api/admin/webhooks', null, tok)).data.webhooks || []) await j('DELETE', `/api/admin/webhooks/${w.id}`, null, tok);
ok(((await j('GET', '/api/admin/api-tokens', null, tok)).data.tokens || []).length === 0, 'API tokens are gone before the restore');

const back = await j('POST', `/api/full-backup/${made.data.filename}/restore`, {}, tok);
ok(back.status === 200, `restored (${back.data.error || 'ok'})`);

// The session survives the restore (the user row is restored as it was).
const notes = (await j('GET', '/api/notes', null, tok)).data;
const restored = (Array.isArray(notes) ? notes : notes.notes || []).find(n => n.title === 'Keep me');
ok(!!restored && /must come back/.test(restored.body_md || ''), 'the note is back, with its text');
const labels = (await j('GET', '/api/labels', null, tok)).data;
const backLabel = (Array.isArray(labels) ? labels : []).find(l => l.name === 'Home/Garage');
ok(!!backLabel && backLabel.icon === 'home', 'the label is back, with its icon');
ok((restored?.labels || []).includes(backLabel?.id), 'and it is still on the note');
const items = (await j('GET', `/api/notes/${list.id}`, null, tok)).data;
ok((items.items || []).some(i => i.text === 'Milk'), 'checklist items are back');
const settings = (await j('GET', '/api/settings', null, tok)).data;
ok(settings.labelOrder === 'custom' && settings.accentColor === 'mint', `settings are back (${settings.labelOrder}, ${settings.accentColor})`);
const tokens = (await j('GET', '/api/admin/api-tokens', null, tok)).data.tokens || [];
ok(tokens.some(t => t.name === 'For scripts'), `API tokens are back (${tokens.map(t => t.name).join(', ') || 'none'})`);
const hooks = (await j('GET', '/api/admin/webhooks', null, tok)).data.webhooks || [];
ok(hooks.some(w => w.url === 'https://example.com/notetrace-hook'), `webhooks are back (${hooks.length})`);

console.log(f ? `${f} FAILED` : 'all passed');
process.exit(f ? 1 : 0);
