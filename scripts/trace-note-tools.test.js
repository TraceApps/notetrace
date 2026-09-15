/**
 * The shared note tools (server/lib/note-tools.js) against an in-memory
 * stand-in for the notes api.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { executeNoteTool, NOTE_TOOLS, parseToolTime } from '../server/lib/note-tools.js';

function fakeApi() {
  let nextId = 1, nextLabel = 1;
  const notes = new Map();
  const labels = [];
  const clone = (n) => JSON.parse(JSON.stringify(n));
  return {
    notes, labels,
    async getLabels() { return labels.map(l => ({ ...l, note_count: [...notes.values()].filter(n => n.labels.includes(l.id)).length })); },
    async createLabel({ name }) { const l = { id: nextLabel++, name }; labels.push(l); return l; },
    async getNotes({ view = 'notes', label = null, q = '' } = {}) {
      return [...notes.values()]
        .filter(n => view === 'reminders' ? !!n.reminder_at : view === 'archive' ? n.archived : !n.archived)
        .filter(n => label == null || n.labels.includes(label))
        .filter(n => !q || `${n.title} ${n.body_md} ${n.items.map(i => i.text).join(' ')}`.toLowerCase().includes(q.toLowerCase()))
        .map(clone);
    },
    async getNote(id) { return notes.has(id) ? clone(notes.get(id)) : null; },
    async createNote(d) {
      const n = { id: nextId++, title: d.title || '', body_md: d.body_md || '', kind: d.kind, labels: d.labels || [], color: d.color || null,
        pinned: !!d.pinned, archived: false, reminder_at: null, share_role: 'owner',
        items: (d.items || []).map((i, k) => ({ uuid: `u${nextId}-${k}`, text: i.text, checked: !!i.checked })) };
      notes.set(n.id, n);
      return clone(n);
    },
    async updateNote(id, p) { Object.assign(notes.get(id), p); return clone(notes.get(id)); },
    async addItem(id, { text, due_date = null }) { const n = notes.get(id); n.items.push({ uuid: `a${n.items.length}`, text, checked: false, due_date }); return clone(n); },
    async updateItem(id, uuid, p) { const it = notes.get(id).items.find(i => i.uuid === uuid); Object.assign(it, p); return clone(notes.get(id)); },
    async trashNote(id) { notes.get(id).trashed_at = 'now'; return clone(notes.get(id)); },
  };
}

test('every tool in the catalog has an executor', async () => {
  const api = fakeApi();
  for (const t of NOTE_TOOLS) {
    const r = await executeNoteTool(t.name, { id: 999 }, api).catch(e => ({ thrown: e.message }));
    assert.ok(!/Unknown tool/.test(r?.error || ''), `${t.name} has no executor`);
  }
});

test('create a labeled checklist, then search, check an item, and add more', async () => {
  const api = fakeApi();
  const created = await executeNoteTool('create_note', { title: 'Groceries', kind: 'checklist', items: ['Oat milk', 'Limes', 'Lime pickle'], labels: ['Home'] }, api);
  assert.equal(created.ok, true);
  assert.deepEqual(created.note.labels, ['Home']);
  const found = await executeNoteTool('search_notes', { query: 'limes' }, api);
  assert.equal(found.count, 1);
  const ambiguous = await executeNoteTool('check_checklist_item', { id: created.note.id, item: 'lime' }, api);
  assert.match(ambiguous.error, /More than one item/);
  const checked = await executeNoteTool('check_checklist_item', { id: created.note.id, item: 'limes' }, api);
  assert.deepEqual([checked.item, checked.checked], ['Limes', true]);
  await executeNoteTool('append_to_note', { id: created.note.id, text: '- Eggs\n- [ ] Bread' }, api);
  const note = await executeNoteTool('get_note', { id: created.note.id }, api);
  assert.deepEqual(note.items.map(i => i.text), ['Oat milk', 'Limes', 'Lime pickle', 'Eggs', 'Bread']);
  const byLabel = await executeNoteTool('search_notes', { label: 'home' }, api);
  assert.equal(byLabel.count, 1);
});

test('text notes: append adds a paragraph, update keeps a version', async () => {
  const api = fakeApi();
  const { note } = await executeNoteTool('create_note', { title: 'Ideas', text: 'First idea' }, api);
  await executeNoteTool('append_to_note', { id: note.id, text: 'Second idea' }, api);
  assert.equal(api.notes.get(note.id).body_md, 'First idea\n\nSecond idea');
  await executeNoteTool('update_note', { id: note.id, text: 'Rewritten' }, api);
  assert.equal(api.notes.get(note.id).snapshot, 'restore', 'a whole-text rewrite asks for a version');
  const wrong = await executeNoteTool('add_checklist_items', { id: note.id, items: ['x'] }, api);
  assert.match(wrong.error, /text note/);
});

test('reminders use local time, and shared view-only notes are protected', async () => {
  const api = fakeApi();
  const { note } = await executeNoteTool('create_note', { title: 'Dentist' }, api);
  const past = await executeNoteTool('set_reminder', { id: note.id, at: '2001-01-01T09:00' }, api);
  assert.match(past.error, /already passed/);
  const ok = await executeNoteTool('set_reminder', { id: note.id, at: '2099-03-01T09:30', repeat: 'weekly' }, api);
  assert.equal(ok.ok, true);
  const local = parseToolTime('2099-03-01T09:30');
  assert.equal(local.getHours(), 9);
  // A wall-clock time in a given zone, whatever this machine's zone is.
  assert.equal(parseToolTime('2099-03-01T09:30', 'America/New_York').toISOString(), '2099-03-01T14:30:00.000Z');
  assert.equal(parseToolTime('2099-07-01T09:30', 'America/New_York').toISOString(), '2099-07-01T13:30:00.000Z');
  assert.equal(parseToolTime('2099-03-01T09:30:00+01:00', 'America/New_York').toISOString(), '2099-03-01T08:30:00.000Z');
  const zoned = await executeNoteTool('set_reminder', { id: note.id, at: '2099-03-01T09:30' }, api, { timeZone: 'Asia/Tokyo' });
  assert.ok(zoned.ok);
  assert.equal(api.notes.get(note.id).reminder_tz, 'Asia/Tokyo');
  assert.match(api.notes.get(note.id).reminder_at, /^2099-03-01 00:30/);
  assert.match((await executeNoteTool('set_reminder', { id: note.id, at: '2099-03-01T09:30', time_zone: 'Mars/Base' }, api)).error, /Unknown time zone/);
  await executeNoteTool('set_reminder', { id: note.id, at: '2099-03-01T09:30', repeat: 'weekly' }, api);
  assert.equal(api.notes.get(note.id).reminder_rrule, 'weekly');
  const reminders = await executeNoteTool('list_reminders', {}, api);
  assert.equal(reminders.reminders.length, 1);

  api.notes.get(note.id).share_role = 'view';
  assert.match((await executeNoteTool('update_note', { id: note.id, text: 'x' }, api)).error, /view only/);
  assert.match((await executeNoteTool('move_to_trash', { id: note.id }, api)).error, /owner/);
  assert.match((await executeNoteTool('set_reminder', { id: note.id, clear: true }, api)).error, /owner/);
});

test('due dates: add with due, set, clear, and list tasks', async () => {
  const api = fakeApi();
  const list = await api.createNote({ title: 'Chores', kind: 'checklist', items: [{ text: 'Sweep' }, { text: 'Done thing', checked: true }] });
  await api.createNote({ title: 'Plain', kind: 'text', body_md: 'hi' });
  const added = await executeNoteTool('add_checklist_items', { id: list.id, items: ['Taxes', 'Bins'], due: '2099-04-15' }, api);
  assert.equal(added.added, 2);
  assert.equal(added.note.items.find(i => i.text === 'Taxes').due, '2099-04-15');
  assert.match((await executeNoteTool('add_checklist_items', { id: list.id, items: ['x'], due: 'soon' }, api)).error, /YYYY-MM-DD/);
  assert.equal((await executeNoteTool('set_due_date', { id: list.id, item: 'sweep', due: '2099-01-02' }, api)).due, '2099-01-02');
  assert.match((await executeNoteTool('set_due_date', { id: list.id, item: 'sweep', due: '2099-02-30' }, api)).error, /YYYY-MM-DD/);
  let all = await executeNoteTool('list_tasks', {}, api);
  assert.deepEqual(all.tasks.map(t => t.text), ['Sweep', 'Taxes', 'Bins']);
  assert.equal(all.tasks[0].list, 'Chores');
  const soon = await executeNoteTool('list_tasks', { due_by: '2099-03-01' }, api);
  assert.deepEqual(soon.tasks.map(t => t.text), ['Sweep']);
  assert.equal((await executeNoteTool('list_tasks', { due_by: '2099-03-01', include_undated: true }, api)).count, 1);
  assert.match((await executeNoteTool('list_tasks', { due_by: 'tomorrow' }, api)).error, /YYYY-MM-DD/);
  assert.equal((await executeNoteTool('set_due_date', { id: list.id, item: 'Taxes', clear: true }, api)).due, null);
  all = await executeNoteTool('list_tasks', { due_by: '2099-12-31' }, api);
  assert.deepEqual(all.tasks.map(t => t.text), ['Sweep', 'Bins']);
});

test('MCP tiers cover every tool exactly once', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../server/lib/mcp/tools/notes.js', import.meta.url), 'utf8');
  const list = (name) => [...src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
  const tiers = [...list('READ'), ...list('WRITE'), ...list('DESTROY')];
  assert.deepEqual([...tiers].sort(), NOTE_TOOLS.map(t => t.name).sort());
});
