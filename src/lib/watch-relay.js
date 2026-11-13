/**
 * watch-relay.js: the phone answering its watch in Local mode.
 *
 * With a server, the watch talks to it directly. In Local mode there is no
 * server, so the watch sends the same requests to the phone over the Wear
 * connection (WearPairingPlugin), and they are answered here by the same
 * local handlers the phone's own screens use (api-native.js).
 *
 * Only what the watch asks for is answered: its notes and reminders, a note
 * said aloud, a reminder done, an item added or ticked. The CookTrace
 * shopping list needs a server, so it answers as one with CookTrace unlinked.
 */
import { watchNote } from '../../server/lib/note-excerpt.js';

/** The address a phone in Local mode gives its watch instead of a server's. */
export const PHONE_ADDRESS = 'phone:';

const NOTES = /^\/api\/notes$/;
const NOTE = /^\/api\/notes\/(\d+)$/;
const ITEMS = /^\/api\/notes\/(\d+)\/items$/;
const ITEM = /^\/api\/notes\/(\d+)\/items\/([^/]+)$/;
const SHOPPING = /^\/api\/integrations\/cooktrace\/shopping(\/\d+)?$/;

const notFound = (e) => /not found/i.test(String(e?.message || ''));

/** Only the fields the watch sends (NoteApi.kt), and when it made the change. */
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));
const MADE = ['edited_at', 'client_now'];

/**
 * Answer one request from the watch.
 *
 * @param {{ method?: string, path?: string, body?: string|null }} req
 * @param {{ localMode: boolean, api: object, watchNotes?: () => any }} deps
 *   api: NoteApiNative; watchNotes: the note ids chosen for the watch.
 * @returns {Promise<{ status: number, body: string, changed?: boolean }>}
 *   changed: a note changed, for the pages on show and the reminders.
 */
export async function answerWatchRequest(req, { localMode, api, watchNotes = () => [] }) {
  const reply = (status, data) => ({ status, body: JSON.stringify(data) });
  const wrote = (status, data) => ({ ...reply(status, data), changed: true });
  // Switched to a server since the watch paired: it pairs again with that.
  if (!localMode) return reply(409, { error: 'The phone is connected to a server now.' });
  const method = String(req?.method || 'GET').toUpperCase();
  let url;
  try { url = new URL(String(req?.path || ''), 'http://phone'); } catch { return reply(400, { error: 'Bad request' }); }
  const path = url.pathname;
  const q = url.searchParams;
  let body = {};
  if (req?.body != null && req.body !== '') {
    try { body = JSON.parse(req.body) || {}; } catch { return reply(400, { error: 'Bad request' }); }
  }
  try {
    let m;
    if (method === 'GET' && NOTES.test(path) && q.get('slim') === '1') {
      // As the server lists them (routes/notes.js): the notes, or reminders,
      // slim, and with watch=1 only the ones chosen for the watch.
      const view = q.get('view') === 'reminders' ? 'reminders' : 'notes';
      const notes = await api.getNotes({ view });
      const ids = q.get('watch') === '1' ? watchNotes() : null;
      const chosen = Array.isArray(ids) && ids.length ? new Set(ids.map(Number)) : null;
      return reply(200, (chosen ? notes.filter(n => chosen.has(n.id)) : notes).map(watchNote));
    }
    if (method === 'POST' && NOTES.test(path)) {
      return wrote(201, await api.createNote(pick(body, ['title', 'body_md', 'kind', 'reminder_at', 'reminder_tz'])));
    }
    if (method === 'PATCH' && (m = NOTE.exec(path))) {
      return wrote(200, await api.updateNote(Number(m[1]), pick(body, ['reminder_at', 'reminder_seen', ...MADE])));
    }
    if (method === 'POST' && (m = ITEMS.exec(path))) {
      // A checklist to add to, as the server asks (lib/notes.js addItem).
      const note = await api.getNote(Number(m[1]));
      if (!note || note.kind !== 'checklist') return reply(404, { error: 'Note not found' });
      return wrote(201, await api.addItem(note.id, { text: body.text }));
    }
    if (method === 'PATCH' && (m = ITEM.exec(path))) {
      return wrote(200, await api.updateItem(Number(m[1]), decodeURIComponent(m[2]), pick(body, ['checked', ...MADE])));
    }
    // CookTrace is linked through a server; with none, it isn't linked.
    if (SHOPPING.test(path)) return reply(409, { error: 'CookTrace is not linked' });
    return reply(404, { error: 'Not found' });
  } catch (e) {
    if (notFound(e)) return reply(404, { error: e.message });
    return reply(500, { error: e?.message || 'The phone could not answer' });
  }
}
