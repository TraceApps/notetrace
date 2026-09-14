/**
 * MCP note tools. The catalog and logic are shared with Trace
 * (lib/note-tools.js); this file adapts lib/notes.js to the api shape the
 * tools expect and registers each tool in its tier:
 *   read:    search_notes, get_note, list_labels, list_reminders
 *   write:   create_note, update_note, append_to_note, add_checklist_items,
 *            check_checklist_item, set_reminder, set_labels
 *   destroy: move_to_trash
 * Every call runs as the token's user, with the same sharing and
 * ownership rules as the app. set_reminder reads a time without an offset
 * in the tool's `time_zone`, else the zone of the user's latest reminder
 * (set from their own device), else the server's.
 */
import { z } from 'zod';
import db from '../../../db.js';
import * as Notes from '../../notes.js';
import { NOTE_TOOLS, executeNoteTool } from '../../note-tools.js';
import { toolResult, toolError } from '../_util.js';

export const READ = ['search_notes', 'get_note', 'list_labels', 'list_reminders'];
export const WRITE = ['create_note', 'update_note', 'append_to_note', 'add_checklist_items', 'check_checklist_item', 'set_reminder', 'set_labels'];
export const DESTROY = ['move_to_trash'];

export function notesApiFor(u) {
  const must = (v, what = 'Note not found') => { if (!v) throw new Error(what); return v; };
  return {
    async getLabels() { return Notes.listLabels(u); },
    async createLabel(d) { const r = Notes.createLabel(u, d); if (r?.error) throw new Error(r.error); return r; },
    async getNotes({ view, label, q } = {}) { return Notes.listNotes(u, { view, labelId: label ?? null, q: q || '' }); },
    async getNote(id) { return Notes.getNote(u, Number(id)); },
    async createNote(d) { return Notes.createNote(u, d); },
    async updateNote(id, patch) { return must(Notes.updateNote(u, Number(id), patch)); },
    async addItem(id, d) { return must(Notes.addItem(u, Number(id), d), 'Checklist not found or not editable'); },
    async updateItem(id, uuid, patch) { return must(Notes.updateItem(u, Number(id), uuid, patch), 'Item not found'); },
    async trashNote(id) { return must(Notes.trashNote(u, Number(id))); },
  };
}

/** The user's time zone, as last recorded by one of their devices on a reminder. */
export function userTimeZone(u) {
  const row = db.prepare(
    `SELECT reminder_tz FROM notes WHERE user_id IS ? AND reminder_tz IS NOT NULL AND reminder_tz != '' ORDER BY updated_at DESC LIMIT 1`
  ).get(u ?? null);
  return row?.reminder_tz || null;
}

// JSON Schema (as used for Trace) to the zod shape registerTool wants.
function _zod(prop) {
  let t;
  if (prop.enum) t = z.enum(prop.enum);
  else if (prop.type === 'integer') t = z.number().int();
  else if (prop.type === 'boolean') t = z.boolean();
  else if (prop.type === 'array') t = z.array(z.string().max(5000)).max(500);
  else t = z.string().max(100000);
  return prop.description ? t.describe(prop.description) : t;
}

export function inputShape(tool) {
  const required = new Set(tool.parameters.required || []);
  const shape = {};
  for (const [key, prop] of Object.entries(tool.parameters.properties || {})) {
    shape[key] = required.has(key) ? _zod(prop) : _zod(prop).optional();
  }
  return shape;
}

function _register(server, ctx, names, { confirm = false } = {}) {
  for (const name of names) {
    const tool = NOTE_TOOLS.find(t => t.name === name);
    const shape = inputShape(tool);
    // Destructive tools need an explicit confirm=true on every call.
    if (confirm) shape.confirm = z.literal(true).describe('Must be true: confirms the destructive action.');
    server.registerTool(
      name,
      { title: name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), description: tool.description, inputSchema: shape },
      async ({ confirm: _c, ...args }) => {
        try {
          const r = await executeNoteTool(name, args, notesApiFor(ctx.userId), { timeZone: userTimeZone(ctx.userId) });
          return r?.error ? toolError(r.error) : toolResult(r);
        } catch (e) {
          return toolError(e.message || 'Tool failed');
        }
      },
    );
  }
}

export const registerNoteReadTools = (server, ctx) => _register(server, ctx, READ);
export const registerNoteWriteTools = (server, ctx) => _register(server, ctx, WRITE);
export const registerNoteDestroyTools = (server, ctx) => _register(server, ctx, DESTROY, { confirm: true });
