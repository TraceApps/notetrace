/**
 * pending-voice.js: voice notes that couldn't be uploaded yet.
 *
 * A recording whose upload fails (no signal, the server restarting) isn't
 * thrown away: it's kept in IndexedDB on this device with the note it belongs
 * to, and uploaded again when the connection comes back, the app returns to
 * the foreground, or once a minute. When it goes up, it's attached to its note
 * and transcribed, unless an open editor for that note takes it over.
 *
 * `pendingVoice` lists what's waiting ({ id, noteId, uuid, durationMs,
 * waveform, error }), so the editor can show it.
 */
import { writable, get } from 'svelte/store';
import { NoteApi } from './api.js';
import { uploadVoiceNote } from './voice-recorder.js';
import { signalNotesChanged } from '../stores/notes.js';

const DB = 'note-pending-voice';
const STORE = 'items';

export const pendingVoice = writable([]);

function _db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _tx(mode, fn) {
  const db = await _db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(out?.result ?? out); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

const _all = () => _tx('readonly', s => s.getAll());

async function _refresh() {
  try {
    const rows = await _all();
    pendingVoice.set(rows.map(({ blob, ...r }) => r));
    return rows;
  } catch {
    return [];
  }
}

function _uuid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Keep a recording for later: { blob, mime, durationMs, waveform } on note
 * `noteId`. With no note yet (a new note while offline), `draft` holds what
 * to create it with when the connection is back.
 */
export async function queueVoiceNote(noteId, rec, draft = null) {
  const item = {
    id: _uuid(), uuid: _uuid(), noteId: noteId ?? null, draft: noteId == null ? draft : null, blob: rec.blob, mime: rec.mime,
    durationMs: rec.durationMs, waveform: rec.waveform || null, createdAt: Date.now(), attempts: 0, error: null,
  };
  await _tx('readwrite', s => s.put(item));
  await _refresh();
  _schedule();
  return item;
}

export async function discardPendingVoice(id) {
  await _tx('readwrite', s => s.delete(id));
  await _refresh();
}

export const hasPendingFor = (noteId) => get(pendingVoice).some(p => p.noteId === noteId);

let _flushing = false;
/** Try every waiting recording once. */
export async function flushPendingVoice() {
  if (_flushing || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  _flushing = true;
  try {
    for (const item of await _refresh()) {
      let att;
      try {
        if (item.noteId == null) {
          const created = await NoteApi.createNote(item.draft || { title: '', body_md: '', kind: 'text' });
          item.noteId = created.id;
          item.draft = null;
          await _tx('readwrite', s => s.put(item));
        }
        att = { ...(await uploadVoiceNote(item)), uuid: item.uuid };
        await NoteApi.addAttachments(item.noteId, [att]);
      } catch (e) {
        await _tx('readwrite', s => s.put({ ...item, attempts: item.attempts + 1, error: String(e?.message || e) }));
        continue;
      }
      await _tx('readwrite', s => s.delete(item.id));
      // An open editor for the note shows it and transcribes it; otherwise it's done here.
      const ev = new CustomEvent('note:voice-uploaded', { detail: { noteId: item.noteId, att, blob: item.blob, handled: false } });
      window.dispatchEvent(ev);
      if (!ev.detail.handled) {
        signalNotesChanged();
        _transcribeLater(item.noteId, att, item.blob);
      }
    }
  } finally {
    _flushing = false;
    await _refresh();
  }
}

async function _transcribeLater(noteId, att, blob) {
  try {
    const { autoTranscribe } = await import('../stores/settings.js');
    const { extractSupport, transcribeVoiceNote } = await import('./ai-extract.js');
    if (!get(autoTranscribe) || !get(extractSupport).transcribe) return;
    const { text, segments } = await transcribeVoiceNote(att, blob);
    if (text) await NoteApi.updateAttachment(noteId, att.uuid, { extracted_text: text, segments });
    signalNotesChanged();
  } catch { /* the note keeps a Transcribe button */ }
}

let _timer = null;
function _schedule() {
  if (_timer) return;
  _timer = setInterval(async () => {
    await flushPendingVoice();
    if (!get(pendingVoice).length) { clearInterval(_timer); _timer = null; }
  }, 60 * 1000);
}

let _started = false;
export async function startPendingVoice() {
  if (_started || typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
  _started = true;
  window.addEventListener('online', () => flushPendingVoice());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flushPendingVoice(); });
  const rows = await _refresh();
  if (rows.length) { _schedule(); flushPendingVoice(); }
}
