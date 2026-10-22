/**
 * public-notes.js: the note a POST /api/v1/notes asks for (TraceApps/notetrace#42).
 *
 * Another app (an email client, a script, an automation) adds a note or a
 * task with a token that can do nothing else. Everything is checked before
 * anything is written, and the note, its new labels and its reminder are
 * written in one transaction, so a refused request leaves nothing behind.
 * The rules are the ones MCP's create_note and set_reminder follow
 * (note-tools.js), on the same notes layer the app uses.
 */
import db from '../db.js';
import * as Notes from './notes.js';
import { NOTE_COLORS, cleanDueDate } from './notes.js';
import { REPEATS, toUtcString, localTimeZone } from './reminders.js';
import { validTimeZone, parseToolTime, fullNote } from './note-tools.js';
import { userTimeZone } from './mcp/tools/notes.js';

const MAX_TITLE = 1000;
const MAX_TEXT = 100_000;
const MAX_ITEMS = 200;
const MAX_ITEM = 2000;
const MAX_LABELS = 20;
const MAX_URL = 2000;

const _bad = (field, error) => ({ error, field });

/** The link line a note gets for where it came from: plain Markdown, so sync, backups and export keep it. */
export function sourceLink(url, title) {
  // Characters that would end or break a Markdown link, percent-encoded
  // (encodeURIComponent leaves the parentheses alone).
  const href = String(url).replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  const label = String(title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
    || new URL(url).host;
  return `[${label.replace(/([\\[\]])/g, '\\$1')}](${href})`;
}

/**
 * Check a request body. Returns { data, labels } for createPublicNote, or
 * { error, field } for a 400.
 */
export function checkPublicNote(body, u) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return _bad(null, 'Send one note as a JSON object.');
  const b = body;
  if (b.title != null && typeof b.title !== 'string') return _bad('title', 'title must be text.');
  if (b.text != null && typeof b.text !== 'string') return _bad('text', 'text must be text.');
  const title = String(b.title || '').trim();
  if (title.length > MAX_TITLE) return _bad('title', `title is longer than ${MAX_TITLE} characters.`);
  let text = String(b.text || '');
  if (text.length > MAX_TEXT) return _bad('text', `text is longer than ${MAX_TEXT} characters.`);

  if (b.kind != null && b.kind !== 'text' && b.kind !== 'checklist') return _bad('kind', 'kind is text or checklist.');
  if (b.items != null && !Array.isArray(b.items)) return _bad('items', 'items is a list.');
  const kind = b.kind || (Array.isArray(b.items) && b.items.length && !text ? 'checklist' : 'text');
  if (kind === 'text' && b.items?.length) return _bad('items', 'items are for kind checklist.');
  if (kind === 'checklist' && text) return _bad('text', 'A checklist has items, not text.');

  let due = null;
  if (b.due != null) {
    due = cleanDueDate(b.due);
    if (!due) return _bad('due', `Couldn't read the due date "${b.due}". Use YYYY-MM-DD.`);
    if (kind !== 'checklist') return _bad('due', 'due is for the items of a checklist.');
  }
  const items = [];
  if (kind === 'checklist') {
    const list = b.items || [];
    if (!list.length) return _bad('items', 'A checklist needs at least one item.');
    if (list.length > MAX_ITEMS) return _bad('items', `At most ${MAX_ITEMS} items.`);
    for (const [i, raw] of list.entries()) {
      const it = typeof raw === 'string' ? { text: raw } : raw;
      if (!it || typeof it !== 'object' || typeof it.text !== 'string') return _bad(`items[${i}]`, 'Each item is text, or { "text": ..., "due": "YYYY-MM-DD" }.');
      const t = it.text.trim();
      if (!t) return _bad(`items[${i}]`, 'An item has no text.');
      if (t.length > MAX_ITEM) return _bad(`items[${i}]`, `An item is longer than ${MAX_ITEM} characters.`);
      let itemDue = due;
      if (it.due != null) {
        itemDue = cleanDueDate(it.due);
        if (!itemDue) return _bad(`items[${i}].due`, `Couldn't read the due date "${it.due}". Use YYYY-MM-DD.`);
      }
      items.push({ text: t, checked: false, due_date: itemDue });
    }
  }
  if (b.show_in_tasks != null && typeof b.show_in_tasks !== 'boolean') return _bad('show_in_tasks', 'show_in_tasks is true or false.');
  if (b.show_in_tasks && kind !== 'checklist') return _bad('show_in_tasks', 'Only a checklist shows in Tasks.');

  if (b.labels != null && !Array.isArray(b.labels)) return _bad('labels', 'labels is a list of names.');
  const labels = [];
  for (const raw of b.labels || []) {
    if (typeof raw !== 'string') return _bad('labels', 'labels is a list of names.');
    // The same cleaning createLabel does, so a name found here is the name it stores.
    const name = raw.trim().replace(/^#/, '').trim().slice(0, 60).trim();
    if (name && !labels.some(l => l.toLowerCase() === name.toLowerCase())) labels.push(name);
  }
  if (labels.length > MAX_LABELS) return _bad('labels', `At most ${MAX_LABELS} labels.`);

  if (b.color != null && b.color !== '' && !NOTE_COLORS.has(b.color)) return _bad('color', `Unknown color "${b.color}". Use one of ${[...NOTE_COLORS].join(', ')}.`);
  if (b.pinned != null && typeof b.pinned !== 'boolean') return _bad('pinned', 'pinned is true or false.');

  let reminder = null;
  if (b.reminder != null) {
    const r = b.reminder;
    if (typeof r !== 'object' || Array.isArray(r) || !r.at) return _bad('reminder', 'reminder is { "at": ..., "time_zone"?: ..., "repeat"?: ... }.');
    if (r.time_zone != null && !validTimeZone(r.time_zone)) return _bad('reminder.time_zone', `Unknown time zone "${r.time_zone}". Use an IANA name like America/New_York.`);
    if (r.repeat != null && r.repeat !== 'none' && !REPEATS.includes(r.repeat)) return _bad('reminder.repeat', `Unknown repeat "${r.repeat}". Use ${REPEATS.join(', ')} or none.`);
    const tz = validTimeZone(r.time_zone) || validTimeZone(userTimeZone(u)) || localTimeZone();
    const when = parseToolTime(r.at, tz);
    if (!when) return _bad('reminder.at', `Couldn't read the time "${r.at}". Use a form like 2026-09-20T09:00, or ISO with an offset.`);
    const repeat = REPEATS.includes(r.repeat) ? r.repeat : null;
    if (!repeat && when <= new Date()) return _bad('reminder.at', 'That time has already passed.');
    reminder = { reminder_at: toUtcString(when), reminder_rrule: repeat, reminder_tz: tz };
  }

  if (b.source_title != null && typeof b.source_title !== 'string') return _bad('source_title', 'source_title must be text.');
  if (b.source_title && b.source_url == null) return _bad('source_url', 'source_title needs source_url.');
  if (b.source_url != null) {
    let u2 = null;
    try { u2 = new URL(String(b.source_url)); } catch {}
    if (!u2 || !/^https?:$/.test(u2.protocol) || String(b.source_url).length > MAX_URL) {
      return _bad('source_url', `source_url must be an http or https address of at most ${MAX_URL} characters.`);
    }
    const link = sourceLink(u2.href, b.source_title);
    // A text note ends with it; a checklist has no text, so its first item does,
    // where the card's link preview picks it up.
    if (kind === 'text') text = text.trim() ? `${text.replace(/\s+$/, '')}\n\n${link}` : link;
    else items[0].text = `${items[0].text} ${u2.href}`;
  }

  if (!title && !text && !items.length) return _bad(null, 'A note needs a title, text or items.');
  return {
    labels,
    data: {
      title, kind, body_md: kind === 'text' ? text : '', items,
      color: b.color || null, pinned: !!b.pinned,
      in_tasks: kind === 'checklist' && !!b.show_in_tasks,
      ...(reminder || {}),
    },
  };
}

/** Write a checked note: its new labels, the note, its reminder. All or nothing. */
export const createPublicNote = db.transaction((u, { data, labels }) => {
  const existing = new Map(Notes.listLabels(u).map(l => [l.name.toLowerCase(), l.id]));
  const ids = [];
  for (const name of labels) {
    let id = existing.get(name.toLowerCase());
    if (!id) {
      const made = Notes.createLabel(u, { name });
      if (made?.error) throw new Error(made.error);
      id = made.id;
    }
    ids.push(id);
  }
  const note = Notes.createNote(u, { ...data, labels: ids });
  return fullNote(note, new Map(Notes.listLabels(u).map(l => [l.id, l.name])));
});
