/**
 * voice-recorder.js: record a voice note with MediaRecorder (browsers and the
 * Android WebView; the app declares RECORD_AUDIO). Opus in WebM where
 * supported, AAC in MP4 otherwise (Safari).
 */
import { NoteApi } from './api.js';

export const MAX_RECORDING_MS = 10 * 60 * 1000;

export function recordingSupported() {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof window.MediaRecorder !== 'undefined';
}

function _mimeType() {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (window.MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}

/** Start recording. Resolves a handle: { stop(): Promise<{ blob, mime, durationMs }>, cancel(), startedAt }. */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mimeType = _mimeType();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 48000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const startedAt = Date.now();
  rec.start(1000);
  const release = () => stream.getTracks().forEach(t => t.stop());
  let limitTimer = null;
  const done = new Promise((resolve) => {
    rec.onstop = () => {
      clearTimeout(limitTimer);
      release();
      const mime = (rec.mimeType || mimeType || 'audio/webm').split(';')[0];
      resolve({ blob: new Blob(chunks, { type: mime }), mime, durationMs: Date.now() - startedAt });
    };
  });
  const handle = {
    startedAt,
    stop() { if (rec.state !== 'inactive') rec.stop(); return done; },
    cancel() { chunks.length = 0; if (rec.state !== 'inactive') rec.stop(); release(); },
  };
  limitTimer = setTimeout(() => handle.stop(), MAX_RECORDING_MS);
  return handle;
}

function _uuid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/** Upload a recording. Resolves an attachment record for NoteApi.addAttachments. */
export async function uploadVoiceNote({ blob, mime, durationMs }) {
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const file = new File([blob], `voice-${stamp}.${ext}`, { type: mime });
  const url = await NoteApi.uploadImage(file);
  if (!url) throw new Error('Upload failed');
  return { uuid: _uuid(), url, mime, duration_ms: Math.round(durationMs) };
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
