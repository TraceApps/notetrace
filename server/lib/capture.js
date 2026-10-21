import { createHash } from 'node:crypto';
import { z } from 'zod';
import db from '../db.js';
import * as Notes from './notes.js';
import { dispatchWebhookEvent } from './webhooks.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
});
const zone = z.string().max(100).refine(v => {
  try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; }
});
const source = z.object({
  id: z.string().min(1).max(1000),
  url: z.string().max(4000).refine(v => {
    try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
  }),
  subject: z.string().max(1000), sender: z.string().max(1000), date: z.string().max(100),
}).strict();
const entry = z.object({
  key: z.string().min(1).max(200), kind: z.enum(['note', 'task']), title: z.string().trim().min(1).max(1000),
  markdown: z.string().max(100000).default(''),
  due_date: date.nullable().optional(), reminder_at: z.string().datetime({ offset: true }).nullable().optional(),
  time_zone: zone.default('UTC'), labels: z.array(z.string().trim().min(1).max(60)).max(20).default(['MailFlow']),
  deadline_quote: z.string().max(2000).optional(),
}).strict();
export const captureSchema = z.object({
  version: z.literal(1), request_id: z.string().min(1).max(200), source, entries: z.array(entry).min(1).max(50),
}).strict();

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export function importCapture(userId, raw) {
  const parsed = captureSchema.safeParse(raw);
  if (!parsed.success) fail('Invalid capture. Check titles, dates, time zone, and selected items.');
  const input = parsed.data;
  const digest = hash(input);
  const created = [];
  const result = db.transaction(() => {
    const previous = db.prepare('SELECT digest, result FROM capture_requests WHERE user_id = ? AND request_id = ?').get(userId, input.request_id);
    if (previous) {
      if (previous.digest !== digest) fail('This save identifier was already used for different content.', 409);
      return { ...JSON.parse(previous.result), replayed: true };
    }
    if (new Set(input.entries.map(e => e.key)).size !== input.entries.length) fail('Capture contains duplicate item keys.');
    const results = input.entries.map(e => {
      const existing = db.prepare('SELECT note_id FROM capture_entries WHERE user_id = ? AND source_id = ? AND entry_key = ?').get(userId, input.source.id, e.key);
      if (existing) {
        const note = Notes.getNote(userId, existing.note_id);
        return { key: e.key, note_id: existing.note_id, status: note && !note.trashed_at ? 'existing' : 'removed' };
      }
      if (e.reminder_at && new Date(e.reminder_at) <= new Date()) fail('Choose a future reminder time or remove the reminder.');
      if (e.kind === 'note' && (e.due_date || e.reminder_at)) fail('Dates and reminders in a capture belong to tasks.');
      const labelIds = e.labels.map(name => {
        const found = Notes.listLabels(userId).find(l => l.name.toLowerCase() === name.toLowerCase());
        const label = found || Notes.createLabel(userId, { name });
        if (!label?.id) fail('Could not create the selected label.');
        return label.id;
      });
      const sourceJson = JSON.stringify({ ...input.source, task: e.kind === 'task', context_md: e.kind === 'task' ? e.markdown : '', deadline_quote: e.deadline_quote || '' });
      const note = Notes.createNote(userId, {
        title: e.title, kind: e.kind === 'task' ? 'checklist' : 'text', body_md: e.markdown,
        in_tasks: e.kind === 'task', items: e.kind === 'task' ? [{ text: e.title, due_date: e.due_date || null }] : [],
        labels: labelIds, reminder_at: e.reminder_at || null, reminder_tz: e.reminder_at ? e.time_zone : null,
      }, { sourceJson, silent: true });
      created.push({ note_id: note.id, title: note.title, kind: note.kind });
      db.prepare('INSERT INTO capture_entries (user_id, source_id, entry_key, note_id) VALUES (?, ?, ?, ?)').run(userId, input.source.id, e.key, note.id);
      return { key: e.key, note_id: note.id, status: 'created' };
    });
    const result = { version: 1, entries: results };
    db.prepare('INSERT INTO capture_requests (user_id, request_id, digest, result) VALUES (?, ?, ?, ?)').run(userId, input.request_id, digest, JSON.stringify(result));
    return result;
  })();
  for (const data of created) {
    try { dispatchWebhookEvent(userId, 'note.created', data); } catch { /* delivery cannot roll back a committed capture */ }
  }
  return result;
}
