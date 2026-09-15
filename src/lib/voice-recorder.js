/**
 * voice-recorder.js: record a voice note with MediaRecorder (browsers and the
 * Android WebView; the app declares RECORD_AUDIO). Opus in WebM where
 * supported, AAC in MP4 otherwise (Safari). Mono at 32 kbps, which keeps an
 * hour of speech around 14 MB, under what transcription services accept.
 *
 * The handle can pause and resume, reports a live input level for the meter,
 * and returns a waveform made from the levels it saw.
 */
import { NoteApi } from './api.js';
import { barsFromLevels } from '../../server/lib/voice-meta.js';

export const MAX_RECORDING_MS = 60 * 60 * 1000;

export function recordingSupported() {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof window.MediaRecorder !== 'undefined';
}

function _mimeType() {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (window.MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}

/** A live input level (0 to 1) read from the microphone stream. */
function _levelMeter(stream) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    // Created after awaiting the microphone, so it can start suspended.
    ctx.resume?.().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    // Measure often and keep the loudest moment since the last read, so short sounds show.
    let peak = 0;
    const poll = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      // RMS of speech sits around 0.02 to 0.2; stretch it so the meter moves.
      peak = Math.max(peak, Math.min(1, Math.sqrt(sum / buf.length) * 4));
    }, 25);
    return {
      read() { const v = peak; peak = 0; return v; },
      close() { clearInterval(poll); ctx.close().catch(() => {}); },
    };
  } catch {
    return { read: () => 0, close() {} };
  }
}

/**
 * Start recording. Resolves a handle:
 *   { stop(): Promise<{ blob, mime, durationMs, waveform }>, cancel(), pause(), resume(),
 *     elapsed(): ms recorded so far (pauses excluded), level(): 0 to 1, paused: boolean, limitMs }
 */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const mimeType = _mimeType();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const meter = _levelMeter(stream);
  const levels = [];
  let recordedMs = 0;
  let runningSince = Date.now();
  const elapsed = () => recordedMs + (runningSince ? Date.now() - runningSince : 0);
  // Sample the level for the waveform while recording.
  // The meter and the waveform share one reading so neither empties it for the other.
  let lastLevel = 0;
  const sampler = setInterval(() => { if (runningSince) levels.push(Math.max(lastLevel, meter.read())); }, 200);
  rec.start(1000);
  const release = () => { clearInterval(sampler); meter.close(); stream.getTracks().forEach(t => t.stop()); };
  let limitTimer = null;
  const armLimit = () => { clearTimeout(limitTimer); limitTimer = setTimeout(() => handle.stop(), Math.max(0, MAX_RECORDING_MS - elapsed())); };
  const done = new Promise((resolve) => {
    rec.onstop = () => {
      clearTimeout(limitTimer);
      const durationMs = elapsed();
      runningSince = 0;
      release();
      const mime = (rec.mimeType || mimeType || 'audio/webm').split(';')[0];
      resolve({ blob: new Blob(chunks, { type: mime }), mime, durationMs, waveform: barsFromLevels(levels) });
    };
  });
  const handle = {
    startedAt: Date.now(),
    limitMs: MAX_RECORDING_MS,
    get paused() { return rec.state === 'paused'; },
    elapsed,
    level: () => (rec.state === 'recording' ? (lastLevel = meter.read()) : 0),
    pause() {
      if (rec.state !== 'recording') return;
      rec.pause();
      recordedMs = elapsed();
      runningSince = 0;
      clearTimeout(limitTimer);
    },
    resume() {
      if (rec.state !== 'paused') return;
      rec.resume();
      runningSince = Date.now();
      armLimit();
    },
    stop() { if (rec.state !== 'inactive') rec.stop(); return done; },
    cancel() { chunks.length = 0; if (rec.state !== 'inactive') rec.stop(); release(); },
  };
  armLimit();
  return handle;
}

function _uuid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/** Upload a recording. Resolves an attachment record for NoteApi.addAttachments. */
export async function uploadVoiceNote({ blob, mime, durationMs, waveform }) {
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const file = new File([blob], `voice-${stamp}.${ext}`, { type: mime });
  const url = await NoteApi.uploadImage(file);
  if (!url) throw new Error('Upload failed');
  return { uuid: _uuid(), url, mime, duration_ms: Math.round(durationMs), ...(waveform ? { waveform } : {}) };
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ── Waveforms for recordings that don't have one ──────────────────────────
const _waveCache = new Map();

/** Decode a recording and measure its waveform. Skips files too big to decode comfortably. */
export async function waveformFromBlob(blob) {
  if (!blob || blob.size > 12 * 1024 * 1024) return null;
  const key = `${blob.size}:${blob.type}`;
  try {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 1, 8000);
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / 640));
    const levels = [];
    for (let i = 0; i < data.length; i += step) {
      let peak = 0;
      for (let j = i; j < i + step && j < data.length; j++) peak = Math.max(peak, Math.abs(data[j]));
      levels.push(peak);
    }
    const bars = barsFromLevels(levels);
    _waveCache.set(key, bars);
    return bars;
  } catch {
    return null;
  }
}
