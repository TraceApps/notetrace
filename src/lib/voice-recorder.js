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
import { barsFromLevels, meterLevel } from '../../server/lib/voice-meta.js';
import { isNative } from './platform.js';

export const MAX_RECORDING_MS = 60 * 60 * 1000;
/** The Android app records natively and keeps going with the screen off. */
export const NATIVE_MAX_RECORDING_MS = 3 * 60 * 60 * 1000;

let _nativePlugin = null;
async function _native() {
  if (!isNative) return null;
  if (!_nativePlugin) {
    const { Capacitor, registerPlugin } = await import('@capacitor/core');
    if (!Capacitor.isPluginAvailable('VoiceRecorder')) return null;
    _nativePlugin = { plugin: registerPlugin('VoiceRecorder'), Capacitor };
  }
  return _nativePlugin;
}

/** Recording through VoiceRecorderPlugin, with the same handle as the browser recorder. */
async function _startNative({ plugin: VR, Capacitor }) {
  await VR.start();
  let status = { state: 'starting', elapsedMs: 0, level: 0 };
  for (let i = 0; i < 60 && status.state === 'starting'; i++) {
    await new Promise(r => setTimeout(r, 50));
    status = await VR.getStatus();
  }
  if (status.state !== 'recording') throw new Error(status.error || 'The microphone isn\'t available');
  let seenAt = Date.now();
  let level = 0;
  const poll = setInterval(async () => {
    try {
      status = await VR.getStatus();
      seenAt = Date.now();
      level = status.level || 0;
    } catch { /* keep the last status */ }
  }, 150);
  const handle = {
    native: true,
    startedAt: Date.now(),
    limitMs: NATIVE_MAX_RECORDING_MS,
    get paused() { return status.state === 'paused'; },
    /** Stopped from the notification while the app was in the background. */
    get finished() { return status.state === 'stopped'; },
    elapsed: () => (status.elapsedMs || 0) + (status.state === 'recording' ? Date.now() - seenAt : 0),
    level: () => meterLevel(level),
    // The background recorder reports how loud it is, not what it hears, so
    // there's no brightness to show on the Android app.
    pitch: () => null,
    pause() { status = { ...status, state: 'paused' }; VR.pause().catch(() => {}); },
    resume() { status = { ...status, state: 'recording' }; seenAt = Date.now(); VR.resume().catch(() => {}); },
    async stop() {
      clearInterval(poll);
      const r = await VR.stop();
      const res = await fetch(Capacitor.convertFileSrc(`file://${r.path}`));
      const blob = new Blob([await res.blob()], { type: 'audio/mp4' });
      return { blob, mime: 'audio/mp4', durationMs: r.durationMs, waveform: r.waveform?.length ? r.waveform : null, path: r.path };
    },
    cancel() { clearInterval(poll); VR.cancel().catch(() => {}); },
  };
  return handle;
}

/** Split a long M4A on this device, for transcribing without a server: [{ blob, offset }]. */
export async function splitRecordingOnDevice(url, seconds) {
  const n = await _native();
  const path = decodeURIComponent(String(url || '').match(/_capacitor_file_(\/.+)$/)?.[1] || '');
  if (!n || !path) return null;
  const { pieces } = await n.plugin.splitFile({ path, seconds: Math.round(seconds) });
  const out = [];
  for (const p of pieces || []) {
    const res = await fetch(n.Capacitor.convertFileSrc(`file://${p.path}`));
    out.push({ blob: new Blob([await res.blob()], { type: 'audio/mp4' }), offset: p.offset });
  }
  return out;
}

export function recordingSupported() {
  return typeof window !== 'undefined' && (isNative || (!!navigator.mediaDevices?.getUserMedia && typeof window.MediaRecorder !== 'undefined'));
}

function _mimeType() {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (window.MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}

/**
 * A live reading of the microphone: how loud (0 to 1, by ear) and how bright
 * (0 to 1, low voice to high), so the meter can show the sound rather than a
 * row of stubs. Brightness is the spectral centroid, which follows the pitch
 * of a voice closely enough to watch.
 */
const PITCH_LOW_HZ = 120;
const PITCH_HIGH_HZ = 2400;
function _levelMeter(stream) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    // Created after awaiting the microphone, so it can start suspended.
    ctx.resume?.().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.15;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const time = new Float32Array(analyser.fftSize);
    const freq = new Float32Array(analyser.frequencyBinCount);
    const binHz = ctx.sampleRate / analyser.fftSize;
    const fromBin = Math.max(1, Math.round(80 / binHz));
    const toBin = Math.min(freq.length, Math.round(5000 / binHz));
    // Measure often and keep the loudest moment since the last read, so short
    // sounds show. The meter and the waveform each get their own reading:
    // sharing one meant whoever read second saw silence.
    let metered = 0;
    let recorded = 0;
    let pitch = 0;
    const poll = setInterval(() => {
      analyser.getFloatTimeDomainData(time);
      let sum = 0;
      for (let i = 0; i < time.length; i++) sum += time[i] * time[i];
      const rms = Math.sqrt(sum / time.length);
      metered = Math.max(metered, rms);
      recorded = Math.max(recorded, rms);
      // Where the energy sits, weighted by how loud each frequency is. Only
      // worth measuring while something is actually being said.
      if (rms < 0.004) return;
      analyser.getFloatFrequencyData(freq);
      let weighted = 0;
      let total = 0;
      for (let i = fromBin; i < toBin; i++) {
        const energy = Math.pow(10, freq[i] / 10);   // dBFS back to energy
        weighted += energy * i * binHz;
        total += energy;
      }
      if (total <= 0) return;
      const centre = weighted / total;
      pitch = Math.max(0, Math.min(1, Math.log2(Math.max(centre, PITCH_LOW_HZ) / PITCH_LOW_HZ) / Math.log2(PITCH_HIGH_HZ / PITCH_LOW_HZ)));
    }, 25);
    return {
      read() { const v = metered; metered = 0; return v; },
      take() { const v = recorded; recorded = 0; return v; },
      pitchNow: () => pitch,
      close() { clearInterval(poll); ctx.close().catch(() => {}); },
    };
  } catch {
    return { read: () => 0, take: () => 0, pitchNow: () => null, close() {} };
  }
}

/**
 * Start recording. Resolves a handle:
 *   { stop(): Promise<{ blob, mime, durationMs, waveform }>, cancel(), pause(), resume(),
 *     elapsed(): ms recorded so far (pauses excluded), level(): 0 to 1, paused: boolean, limitMs }
 */
export async function startRecording() {
  const native = await _native();
  if (native) return _startNative(native);
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
  // Sample the level for the waveform while recording, on its own reading.
  const sampler = setInterval(() => { if (runningSince) levels.push(meter.take()); }, 200);
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
    // The waveform keeps the raw amplitudes (barsFromLevels scales them); the
    // meter shows them by ear.
    level: () => (rec.state === 'recording' ? meterLevel(meter.read()) : 0),
    pitch: () => meter.pitchNow(),
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
