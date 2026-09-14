/**
 * note-tools.js: what Trace and MCP agents can do with notes.
 *
 * One implementation for both. NOTE_TOOLS is the catalog (JSON Schema
 * parameters); executeNoteTool runs a call against a notes api:
 *   - Trace (src/lib/trace-note-tools.js) passes NoteApi, so it works on the
 *     web, on Android with a server, and in local mode
 *   - MCP (lib/mcp/tools/notes.js) passes an adapter over lib/notes.js
 * Either way every change goes through the normal rules: version history,
 * sync, sharing permissions. Pure (no db, no DOM) so it's shared by the
 * server and the client bundle and tested against a fake api.
 */
import { REPEATS, toUtcString, localTimeZone, nextOccurrence } from './reminders.js';

const BODY_LIMIT = 4000;
const RESULT_LIMIT = 25;

export const NOTE_TOOLS = [
  {
    name: 'search_notes',
    description: "Find the user's notes. Full-text search over titles, text, and checklist items, optionally within a label or view. Returns id, title, kind, a text preview or open checklist items, labels, pinned, archived, and reminder. Use this before get_note or any change when you need to find a note by what it says.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for. Omit to list the most recently edited notes.' },
        label: { type: 'string', description: 'Only notes with this label name.' },
        view: { type: 'string', enum: ['notes', 'archive', 'trash', 'reminders'], description: "Which notes to look in. Defaults to 'notes' (not archived, not trashed)." },
        limit: { type: 'integer', description: `Maximum results, up to ${RESULT_LIMIT}. Default 10.` },
      },
    },
  },
  {
    name: 'get_note',
    description: 'Get one note in full: title, Markdown text or every checklist item with its checked state, labels, color, pinned, archived, reminder, sharing, and dates.',
    parameters: { type: 'object', properties: { id: { type: 'integer', description: 'Note id' } }, required: ['id'] },
  },
  {
    name: 'list_labels',
    description: "List the user's labels with how many notes each has.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_reminders',
    description: 'List notes with reminders, soonest next occurrence first, with the next time each one fires.',
    parameters: {
      type: 'object',
      properties: { upcoming_only: { type: 'boolean', description: 'Skip one-off reminders that already passed. Default true.' } },
    },
  },
  {
    name: 'create_note',
    description: "Create a note. Use kind 'checklist' with items for lists (groceries, packing, to-dos); otherwise a text note with Markdown text. Labels are matched by name and created when missing.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        text: { type: 'string', description: 'Markdown text for a text note.' },
        kind: { type: 'string', enum: ['text', 'checklist'] },
        items: { type: 'array', items: { type: 'string' }, description: 'Checklist items, in order.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names.' },
        color: { type: 'string', enum: ['plum', 'moss', 'clay', 'tide', 'sand', 'rose'] },
        pinned: { type: 'boolean' },
      },
    },
  },
  {
    name: 'update_note',
    description: "Change a note's title, replace its Markdown text, or change color, pinned, or archived. The previous text is kept in version history. To add to a note without replacing it, use append_to_note.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        text: { type: 'string', description: 'New Markdown text (text notes only). Replaces the existing text.' },
        color: { type: 'string', enum: ['plum', 'moss', 'clay', 'tide', 'sand', 'rose', 'none'] },
        pinned: { type: 'boolean' },
        archived: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'append_to_note',
    description: 'Add to the end of a note. On a text note the text becomes a new paragraph; on a checklist each line becomes a new item.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' }, text: { type: 'string' } },
      required: ['id', 'text'],
    },
  },
  {
    name: 'add_checklist_items',
    description: 'Add items to a checklist note.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' }, items: { type: 'array', items: { type: 'string' } } },
      required: ['id', 'items'],
    },
  },
  {
    name: 'check_checklist_item',
    description: 'Check or uncheck a checklist item, found by its text (exact match first, then the only item containing the text).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Note id' },
        item: { type: 'string', description: 'Item text' },
        checked: { type: 'boolean', description: 'Default true.' },
      },
      required: ['id', 'item'],
    },
  },
  {
    name: 'set_reminder',
    description: "Set or clear a note's reminder. `at` is a local date and time like 2026-09-20T09:00 (the user's time zone) or a full ISO time with an offset. Repeat is optional.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        at: { type: 'string', description: 'When to remind. Omit with clear=true to remove the reminder.' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'] },
        clear: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'set_labels',
    description: "Replace a note's labels with these label names (created when missing). Pass an empty list to remove all labels.",
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' }, labels: { type: 'array', items: { type: 'string' } } },
      required: ['id', 'labels'],
    },
  },
  {
    name: 'move_to_trash',
    description: 'Move a note to the trash. It can be restored for 30 days. Only the note owner can do this. Confirm with the user first unless they clearly asked.',
    parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
];

function _preview(md, n = 240) {
  const s = String(md || '').replace(/[*_~`>#]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function _reminder(note) {
  if (!note.reminder_at) return null;
  const next = nextOccurrence(note.reminder_at, note.reminder_rrule, note.reminder_tz);
  return { next: next ? next.toISOString() : null, repeat: note.reminder_rrule || null };
}

function _summary(note, labelName) {
  const open = (note.items || []).filter(i => !i.checked);
  return {
    id: note.id,
    title: note.title,
    kind: note.kind,
    ...(note.kind === 'checklist'
      ? { open_items: open.slice(0, 8).map(i => i.text), checked_count: note.items.length - open.length }
      : { preview: _preview(note.body_md) }),
    labels: (note.labels || []).map(id => labelName.get(id)).filter(Boolean),
    pinned: !!note.pinned,
    archived: !!note.archived,
    reminder: _reminder(note),
    images: (note.attachments || []).length,
    updated_at: note.updated_at,
  };
}

function _full(note, labelName) {
  const body = String(note.body_md || '');
  return {
    id: note.id,
    title: note.title,
    kind: note.kind,
    text: note.kind === 'text' ? (body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}\n…(truncated)` : body) : undefined,
    items: note.kind === 'checklist' ? (note.items || []).map(i => ({ text: i.text, checked: !!i.checked })) : undefined,
    labels: (note.labels || []).map(id => labelName.get(id)).filter(Boolean),
    color: note.color || null,
    pinned: !!note.pinned,
    archived: !!note.archived,
    trashed: !!note.trashed_at,
    reminder: _reminder(note),
    images: (note.attachments || []).filter(a => !/^audio\//i.test(a.mime || '')).map(a => ({ text: a.extracted_text || null })),
    voice_notes: (note.attachments || []).filter(a => /^audio\//i.test(a.mime || '')).map(a => ({ seconds: Math.round((a.duration_ms || 0) / 1000), transcript: a.extracted_text || null })),
    shared: note.share_role && note.share_role !== 'owner' ? { role: note.share_role, owner: note.share_owner } : (note.share_count ? { shared_with: note.share_count } : null),
    created_at: note.created_at,
    updated_at: note.updated_at,
  };
}

/** Parse the model's time: local wall-clock ("2026-09-20T09:00") or ISO with an offset. */
export function parseToolTime(at, now = new Date()) {
  const s = String(at || '').trim();
  if (!s) return null;
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(s);
  const local = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/);
  let d;
  if (!hasZone && local) d = new Date(+local[1], +local[2] - 1, +local[3], local[4] != null ? +local[4] : 9, local[5] != null ? +local[5] : 0);
  else d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

async function _labelIds(api, names = []) {
  const labels = await api.getLabels();
  const byName = new Map(labels.map(l => [l.name.toLowerCase(), l.id]));
  const ids = [];
  for (const raw of names) {
    const name = String(raw || '').trim().replace(/^#/, '').slice(0, 60);
    if (!name) continue;
    let id = byName.get(name.toLowerCase());
    if (!id) {
      const created = await api.createLabel({ name });
      id = created?.id;
      if (id) byName.set(name.toLowerCase(), id);
    }
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function _labelNames(api) {
  return new Map((await api.getLabels()).map(l => [l.id, l.name]));
}

function _findItem(items, text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return { error: 'item text is required' };
  const exact = items.filter(i => i.text.trim().toLowerCase() === q);
  if (exact.length === 1) return { item: exact[0] };
  const partial = items.filter(i => i.text.toLowerCase().includes(q));
  if (partial.length === 1) return { item: partial[0] };
  if (!partial.length && !exact.length) return { error: `No item matching "${text}". Items: ${items.map(i => i.text).join('; ')}` };
  return { error: `More than one item matches "${text}": ${(exact.length ? exact : partial).map(i => i.text).join('; ')}. Use the exact text.` };
}

/**
 * Run one tool call. Resolves a JSON-able result, or { error } the model
 * can explain to the user.
 */
export async function executeNoteTool(name, args = {}, api) {
  if (!api) throw new Error('executeNoteTool needs a notes api');
  const a = args || {};
  const need = async (id) => {
    const note = await api.getNote(Number(id));
    if (!note) throw new Error(`Note ${id} not found`);
    return note;
  };
  const canEdit = (note) => note.share_role !== 'view';

  switch (name) {
    case 'search_notes': {
      const labelName = await _labelNames(api);
      let label = null;
      if (a.label) {
        label = [...labelName.entries()].find(([, n]) => n.toLowerCase() === String(a.label).toLowerCase())?.[0] ?? null;
        if (label == null) return { error: `No label named "${a.label}"`, labels: [...labelName.values()] };
      }
      const view = ['notes', 'archive', 'trash', 'reminders'].includes(a.view) ? a.view : 'notes';
      const notes = await api.getNotes({ view, label, q: a.query || '' });
      const limit = Math.min(RESULT_LIMIT, Math.max(1, Number(a.limit) || 10));
      return { count: notes.length, notes: notes.slice(0, limit).map(n => _summary(n, labelName)) };
    }
    case 'get_note':
      return _full(await need(a.id), await _labelNames(api));
    case 'list_labels':
      return { labels: (await api.getLabels()).map(l => ({ name: l.name, notes: l.note_count ?? null })) };
    case 'list_reminders': {
      const labelName = await _labelNames(api);
      const now = new Date();
      const notes = (await api.getNotes({ view: 'reminders' }))
        .map(n => ({ n, next: nextOccurrence(n.reminder_at, n.reminder_rrule, n.reminder_tz, now) }))
        .filter(x => x.next && (a.upcoming_only === false || REPEATS.includes(x.n.reminder_rrule) || x.next > now))
        .sort((x, y) => x.next - y.next);
      return { reminders: notes.slice(0, RESULT_LIMIT).map(({ n }) => _summary(n, labelName)) };
    }
    case 'create_note': {
      const kind = a.kind === 'checklist' || (Array.isArray(a.items) && a.items.length && !a.text) ? 'checklist' : 'text';
      const labels = await _labelIds(api, a.labels);
      const note = await api.createNote({
        title: String(a.title || '').slice(0, 1000),
        body_md: kind === 'text' ? String(a.text || '') : '',
        kind,
        items: kind === 'checklist' ? (a.items || []).map(t => ({ text: String(t), checked: false })) : [],
        labels,
        color: a.color || null,
        pinned: !!a.pinned,
      });
      return { ok: true, note: _full(note, await _labelNames(api)) };
    }
    case 'update_note': {
      const note = await need(a.id);
      if (!canEdit(note) && (a.title !== undefined || a.text !== undefined || a.color !== undefined)) {
        return { error: 'This note is shared with the user as view only, so its content can\'t be changed.' };
      }
      const patch = {};
      if (a.title !== undefined) patch.title = String(a.title);
      if (a.text !== undefined) {
        if (note.kind !== 'text') return { error: 'This is a checklist. Use add_checklist_items or check_checklist_item.' };
        patch.body_md = String(a.text);
        patch.snapshot = 'restore';
      }
      if (a.color !== undefined) patch.color = a.color === 'none' ? null : a.color;
      if (a.pinned !== undefined) patch.pinned = !!a.pinned;
      if (a.archived !== undefined) patch.archived = !!a.archived;
      const updated = await api.updateNote(note.id, patch);
      return { ok: true, note: _full(updated, await _labelNames(api)) };
    }
    case 'append_to_note': {
      const note = await need(a.id);
      if (!canEdit(note)) return { error: 'This note is shared as view only.' };
      const text = String(a.text || '').trim();
      if (!text) return { error: 'text is required' };
      if (note.kind === 'checklist') {
        for (const line of text.split('\n').map(l => l.replace(/^\s*([-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '').trim()).filter(Boolean)) {
          await api.addItem(note.id, { text: line });
        }
      } else {
        await api.updateNote(note.id, { body_md: note.body_md ? `${note.body_md.replace(/\s+$/, '')}\n\n${text}` : text });
      }
      return { ok: true, note: _full(await need(note.id), await _labelNames(api)) };
    }
    case 'add_checklist_items': {
      const note = await need(a.id);
      if (!canEdit(note)) return { error: 'This note is shared as view only.' };
      if (note.kind !== 'checklist') return { error: 'This is a text note. Use append_to_note, or ask the user to switch it to a checklist.' };
      const items = (Array.isArray(a.items) ? a.items : []).map(t => String(t).trim()).filter(Boolean);
      if (!items.length) return { error: 'items is required' };
      for (const text of items) await api.addItem(note.id, { text });
      return { ok: true, added: items.length, note: _full(await need(note.id), await _labelNames(api)) };
    }
    case 'check_checklist_item': {
      const note = await need(a.id);
      if (!canEdit(note)) return { error: 'This note is shared as view only.' };
      if (note.kind !== 'checklist') return { error: 'This note is not a checklist.' };
      const found = _findItem(note.items || [], a.item);
      if (found.error) return { error: found.error };
      const checked = a.checked !== false;
      await api.updateItem(note.id, found.item.uuid, { checked });
      return { ok: true, item: found.item.text, checked };
    }
    case 'set_reminder': {
      const note = await need(a.id);
      if (note.share_role && note.share_role !== 'owner') return { error: 'Only the note owner can set its reminder.' };
      if (a.clear || !a.at) {
        if (!a.clear) return { error: 'Give `at`, or clear=true to remove the reminder.' };
        await api.updateNote(note.id, { reminder_at: null });
        return { ok: true, cleared: true };
      }
      const when = parseToolTime(a.at);
      if (!when) return { error: `Couldn't read the time "${a.at}". Use a form like 2026-09-20T09:00.` };
      const repeat = REPEATS.includes(a.repeat) ? a.repeat : null;
      if (!repeat && when <= new Date()) return { error: 'That time has already passed.' };
      const updated = await api.updateNote(note.id, { reminder_at: toUtcString(when), reminder_rrule: repeat, reminder_tz: localTimeZone() });
      return { ok: true, reminder: _reminder(updated) };
    }
    case 'set_labels': {
      const note = await need(a.id);
      const ids = await _labelIds(api, a.labels || []);
      const updated = await api.updateNote(note.id, { labels: ids });
      const labelName = await _labelNames(api);
      return { ok: true, labels: (updated.labels || []).map(id => labelName.get(id)).filter(Boolean) };
    }
    case 'move_to_trash': {
      const note = await need(a.id);
      if (note.share_role && note.share_role !== 'owner') return { error: 'Only the note owner can move it to the trash.' };
      await api.trashNote(note.id);
      return { ok: true, trashed: note.title || `Note ${note.id}` };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
