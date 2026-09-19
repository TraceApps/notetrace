/**
 * voice-files.js: audio files that come from outside the recorder (picked in
 * the editor, dropped or pasted on it, shared from another app, or imported
 * from Google Keep) becoming voice notes.
 *
 * Formats the browser plays are uploaded as they are. Others (Keep's 3GP/AMR,
 * for example) are converted to M4A by the server, when one is connected and
 * has ffmpeg.
 */
import { NoteApi } from './api.js';
import { isNative, getServerUrl } from './platform.js';

const EXT_MIME = {
  m4a: 'audio/mp4', mp4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac', amr: 'audio/amr', awb: 'audio/amr-wb', '3gp': 'audio/3gpp', '3gpp': 'audio/3gpp',
};

const _ext = (name) => String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';

/** An audio file's type, from its own type or its extension. */
export function audioMime(file) {
  const t = String(file?.type || '').toLowerCase();
  if (t.startsWith('audio/')) return t;
  if (t === 'video/3gpp') return 'audio/3gpp';
  return EXT_MIME[_ext(file?.name)] || '';
}

export const isAudioFile = (file) => !!audioMime(file);

/** Whether this browser can play the file without converting it. */
export function browserPlays(file) {
  const mime = audioMime(file);
  if (!mime || /amr|3gpp/.test(mime)) return false;
  try { return !!document.createElement('audio').canPlayType(mime); } catch { return false; }
}

/** The length of a playable audio file in ms, read from its metadata. */
export function readDurationMs(file) {
  return new Promise((resolve) => {
    let url;
    try { url = URL.createObjectURL(file); } catch { resolve(null); return; }
    const el = document.createElement('audio');
    const done = (ms) => { URL.revokeObjectURL(url); resolve(ms); };
    const timer = setTimeout(() => done(null), 8000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      if (Number.isFinite(el.duration)) { clearTimeout(timer); done(Math.round(el.duration * 1000)); return; }
      el.ondurationchange = () => { if (Number.isFinite(el.duration)) { clearTimeout(timer); done(Math.round(el.duration * 1000)); } };
      el.currentTime = 1e7;
    };
    el.onerror = () => { clearTimeout(timer); done(null); };
    el.src = url;
  });
}

function _uuid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

const _serverAvailable = () => !isNative || !!getServerUrl();

/** Whether the connected server converts audio. */
export async function canConvertAudio() {
  if (!_serverAvailable()) return false;
  try { return !!(await NoteApi.get('/api/upload/capabilities'))?.audio_convert; } catch { return false; }
}

/**
 * Upload an audio file and describe it as a voice note attachment:
 * { uuid, url, mime, duration_ms }. Throws 'unsupported' when it can't be
 * played here and can't be converted.
 */
export async function prepareAudioFile(file) {
  const mime = audioMime(file);
  if (!mime) throw new Error('unsupported');
  const named = file.type === mime ? file : new File([file], file.name || `audio.${_ext(file.name) || 'm4a'}`, { type: mime });
  if (browserPlays(named)) {
    const duration = await readDurationMs(named);
    const url = await NoteApi.uploadImage(named);
    if (!url) throw new Error('Upload failed');
    return { uuid: _uuid(), url, mime, duration_ms: duration };
  }
  if (!_serverAvailable()) throw new Error('unsupported');
  const r = await NoteApi.uploadAudio(named, { convert: true });
  if (!r?.url) throw new Error('unsupported');
  return { uuid: _uuid(), url: r.url, mime: r.mime || 'audio/mp4', duration_ms: r.duration_ms || null };
}
