/**
 * offline-edits.js: note edits made in a browser without a connection.
 *
 * The web app keeps the notes it has seen (the mirror) and, while the server
 * can't be reached, records each edit as an op in an outbox. Ops are applied
 * over the mirror, or over what the server sends before they've gone up, so
 * the screen always shows them. Back online, the outbox becomes one sync push
 * (POST /api/sync/push), the same path the Android app uses, so the server's
 * merge rules decide: the newer edit of a note wins and a losing title or text
 * is kept in version history, checklist items merge one by one, and labels
 * are added or removed individually.
 *
 * Everything here is plain data in, plain data out; offline-api.js does the
 * storage and the network.
 */
import { itemAfterPatch } from '../../server/lib/task-rules.js';

/** Note fields an offline edit may change. */
export const NOTE_FIELDS = ['title', 'body_md', 'color', 'pinned', 'archived', 'in_tasks', 'reminder_at', 'reminder_rrule', 'reminder_tz'];

/** A server-style timestamp (UTC, no zone), as the sync push expects. */
export const stamp = (ms = Date.now()) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/** A note made offline gets a negative id until the server gives it one. */
export const isTempId = (id) => typeof id === 'number' && id < 0;

/** Errors that mean "no connection" rather than "the server said no". */
export function isOfflineError(err) {
  if (!err) return false;
  if (err.offline) return true;
  if (err.name === 'TypeError') return true; // fetch: Failed to fetch, NetworkError, Load failed
  const status = err.status ?? Number(String(err.message || '').match(/API error (\d{3})/)?.[1]);
  return status === 502 || status === 503 || status === 504;
}

// SQLite on the server takes 0 and 1, not true and false.
const _sql = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);

const _copy = (n) => ({ ...n, labels: [...(n.labels || [])], items: (n.items || []).map(i => ({ ...i })), attachments: [...(n.attachments || [])] });

/**
 * Apply one op to a Map of notes by id (changed in place, notes copied first).
 * Ops: create, update, trash, restore, addItem, updateItem, deleteItem, reorderItems.
 */
export function applyOp(byId, op) {
  const at = stamp(op.at);
  if (op.type === 'create') {
    const n = op.note || {};
    byId.set(op.id, {
      id: op.id, title: n.title || '', body_md: n.body_md || '', kind: n.kind === 'checklist' ? 'checklist' : 'text',
      color: n.color ?? null, pinned: !!n.pinned, in_tasks: !!n.in_tasks, archived: false, trashed_at: null,
      reminder_at: n.reminder_at ?? null, reminder_rrule: n.reminder_rrule ?? null, reminder_tz: n.reminder_tz ?? null,
      created_at: at, updated_at: at, labels: [...(n.labels || [])],
      items: (n.items || []).map((i, idx) => ({
        uuid: i.uuid, text: i.text || '', checked: !!i.checked, position: i.position ?? idx + 1,
        due_date: i.due_date ?? null, due_repeat: i.due_repeat ?? null, checked_at: i.checked ? at : null,
      })),
      attachments: [], share_role: 'owner', share_owner: null, share_count: 0,
      offline: true,
    });
    return;
  }
  const current = byId.get(op.id);
  if (!current) return;
  const n = _copy(current);
  n.offline = true;
  switch (op.type) {
    case 'update':
      for (const k of NOTE_FIELDS) if (k in (op.patch || {})) n[k] = op.patch[k];
      if (Array.isArray(op.patch?.labels)) n.labels = [...op.patch.labels];
      n.updated_at = at;
      break;
    case 'trash':
      n.trashed_at = at; n.pinned = false; n.updated_at = at;
      break;
    case 'restore':
      n.trashed_at = null; n.updated_at = at;
      break;
    case 'addItem': {
      const i = op.item || {};
      if (!i.uuid || n.items.some(x => x.uuid === i.uuid)) break;
      const position = i.position ?? (n.items.reduce((m, x) => Math.max(m, x.position ?? 0), 0) + 1);
      // Room for it: items at or after its place move down one.
      if (i.position != null) for (const x of n.items) if ((x.position ?? 0) >= position) x.position = (x.position ?? 0) + 1;
      n.items.push({ uuid: i.uuid, text: i.text || '', checked: !!i.checked, position, due_date: i.due_date ?? null, due_repeat: i.due_repeat ?? null, checked_at: i.checked ? at : null });
      n.items.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      n.updated_at = at;
      break;
    }
    case 'updateItem': {
      const idx = n.items.findIndex(x => x.uuid === op.uuid);
      if (idx < 0) break;
      const before = n.items[idx];
      const after = itemAfterPatch(before, op.patch || {}, op.patch?.today || at.slice(0, 10));
      if (after.checked && !before.checked) after.checked_at = at;
      if (!after.checked) after.checked_at = null;
      n.items[idx] = after;
      n.items.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      n.updated_at = at;
      break;
    }
    case 'deleteItem':
      n.items = n.items.filter(x => x.uuid !== op.uuid);
      n.updated_at = at;
      break;
    case 'reorderItems': {
      const order = new Map((op.uuids || []).map((u, i) => [u, i + 1]));
      for (const x of n.items) if (order.has(x.uuid)) x.position = order.get(x.uuid);
      n.items.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      n.updated_at = at;
      break;
    }
    default:
      return;
  }
  byId.set(op.id, n);
}

/** The notes with every op applied, in op order. */
export function applyOps(notes, ops) {
  const byId = new Map((notes || []).map(n => [n.id, n]));
  for (const op of ops || []) applyOp(byId, op);
  return byId;
}

/** Ids of the notes the ops touch. */
export const touchedIds = (ops) => new Set((ops || []).map(op => op.id));

const _words = (q) => (String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 12);

/** Whether a note matches a search, word beginnings as on the server. */
export function matchesQuery(note, q) {
  const words = _words(q);
  if (!words.length) return true;
  const hay = [note.title, note.body_md, ...(note.items || []).map(i => i.text), ...(note.attachments || []).map(a => a.extracted_text || '')]
    .join('\n').toLowerCase();
  const tokens = new Set(hay.match(/[\p{L}\p{N}]+/gu) || []);
  return words.every(w => [...tokens].some(t => t.startsWith(w)));
}

/** A notes list the way the server builds one for a view, from local notes. */
export function listView(notes, { view = 'notes', label = null, q = '', kind = null } = {}) {
  const owned = (n) => !n.share_role || n.share_role === 'owner';
  let out = [...notes].filter(n => {
    if (view === 'trash') return !!n.trashed_at && owned(n);
    if (n.trashed_at) return false;
    if (view === 'reminders') return !!n.reminder_at && owned(n);
    if (view === 'shared') return !owned(n) && !n.archived;
    return view === 'archive' ? !!n.archived : !n.archived;
  });
  if (kind === 'text' || kind === 'checklist') out = out.filter(n => n.kind === kind);
  if (label != null) out = out.filter(n => (n.labels || []).includes(Number(label)));
  if (q) out = out.filter(n => matchesQuery(n, q));
  const edited = (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  if (view === 'notes') out.sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || edited(a, b));
  else if (view === 'reminders') out.sort((a, b) => String(a.reminder_at).localeCompare(String(b.reminder_at)));
  else out.sort(edited);
  return out;
}

/**
 * A server list with the outbox applied: edited notes show their edits,
 * notes that left the view (archived, trashed) drop out, and notes made
 * offline or moved into the view appear.
 */
export function overlayList(serverList, ops, query, known = []) {
  if (!ops?.length) return serverList;
  const touched = touchedIds(ops);
  const base = new Map(known.map(n => [n.id, n]));
  for (const n of serverList) base.set(n.id, n);
  const applied = applyOps([...base.values()], ops);
  const inView = new Set(listView([...applied.values()], query).map(n => n.id));
  const kept = serverList.filter(n => !touched.has(n.id)).filter(n => inView.has(n.id));
  const changed = [...applied.values()].filter(n => touched.has(n.id) && inView.has(n.id));
  return listView([...kept, ...changed], query);
}

/** Due and overdue list items, like the server's Tasks Due count. */
export function tasksDueCount(notes, today) {
  let count = 0;
  for (const n of notes) {
    if (n.trashed_at || n.archived || n.kind !== 'checklist') continue;
    for (const i of n.items || []) if (!i.checked && i.due_date && i.due_date <= today && String(i.text || '').trim()) count++;
  }
  return count;
}

/**
 * The sync push for the outbox. `base` holds each touched note as the server
 * last sent it (none for notes made offline), `final` the notes with every op
 * applied. Only what changed goes up, stamped with when it changed.
 */
export function buildPush(ops, base, final) {
  const tables = { notes: [], checklist_items: [], note_labels: [] };
  const lastAt = new Map();
  const noteFields = new Map();
  const itemAt = new Map();
  for (const op of ops) {
    const at = stamp(op.at);
    lastAt.set(op.id, at);
    const fields = noteFields.get(op.id) || new Set();
    if (op.type === 'update') for (const k of Object.keys(op.patch || {})) if (NOTE_FIELDS.includes(k)) fields.add(k);
    if (op.type === 'trash') { fields.add('trashed_at'); fields.add('pinned'); }
    if (op.type === 'restore') fields.add('trashed_at');
    noteFields.set(op.id, fields);
    const items = itemAt.get(op.id) || new Map();
    if (op.type === 'addItem' && op.item?.uuid) items.set(op.item.uuid, at);
    if (op.type === 'updateItem' || op.type === 'deleteItem') items.set(op.uuid, at);
    if (op.type === 'reorderItems') for (const u of op.uuids || []) items.set(u, at);
    // Adding at a place moves the items after it too.
    if (op.type === 'addItem' && op.item?.position != null) for (const x of final.get(op.id)?.items || []) if (!items.has(x.uuid)) items.set(x.uuid, at);
    if (op.type === 'create') for (const i of op.note?.items || []) items.set(i.uuid, at);
    itemAt.set(op.id, items);
  }

  for (const id of touchedIds(ops)) {
    const after = final.get(id);
    if (!after) continue;
    const before = base.get(id) || null;
    const created = isTempId(id);
    const at = lastAt.get(id);
    const noteRef = created ? { note_id: id, _local_fks: ['note_id'] } : { note_id: id };

    if (created) {
      const row = { client_id: id, updated_at: at, deleted_at: null, kind: after.kind };
      for (const k of [...NOTE_FIELDS, 'trashed_at']) row[k] = _sql(after[k]);
      tables.notes.push(row);
    } else if (noteFields.get(id)?.size) {
      const row = { client_id: id, server_id: id, updated_at: at };
      for (const k of noteFields.get(id)) row[k] = _sql(after[k]);
      tables.notes.push(row);
    }

    for (const [uuid, itemStamp] of itemAt.get(id) || []) {
      const item = after.items.find(x => x.uuid === uuid);
      const existed = before?.items?.some(x => x.uuid === uuid);
      if (!item && !existed) continue; // added and removed while offline
      if (!item) {
        const old = before.items.find(x => x.uuid === uuid);
        tables.checklist_items.push({ client_id: uuid, uuid, ...noteRef, text: old.text, checked: _sql(!!old.checked), position: old.position, updated_at: itemStamp, deleted_at: itemStamp });
        continue;
      }
      tables.checklist_items.push({
        client_id: uuid, uuid, ...noteRef, text: item.text, checked: _sql(!!item.checked), position: item.position,
        due_date: item.due_date ?? null, due_repeat: item.due_repeat ?? null, checked_at: item.checked_at ?? null,
        updated_at: itemStamp, deleted_at: null,
      });
    }

    const had = new Set(before?.labels || []);
    const has = new Set(after.labels || []);
    for (const labelId of has) if (!had.has(labelId)) tables.note_labels.push({ client_id: `${id}:${labelId}`, ...noteRef, label_id: labelId, updated_at: at, deleted_at: null });
    for (const labelId of had) if (!has.has(labelId)) tables.note_labels.push({ client_id: `${id}:${labelId}`, ...noteRef, label_id: labelId, updated_at: at, deleted_at: at });
  }
  return { tables };
}

/** Server ids for the notes made offline, from the push response. */
export function createdIds(response) {
  const map = {};
  for (const r of Array.isArray(response?.tables?.notes) ? response.tables.notes : []) {
    if (isTempId(r.client_id) && r.server_id) map[r.client_id] = r.server_id;
  }
  return map;
}
