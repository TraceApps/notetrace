/**
 * voice-meta.js: the small extras stored with a voice note. Pure; shared by the
 * server, the Android app's local database, and the player.
 *
 *   waveform: bar heights 0-100 (at most WAVEFORM_BARS), saved as JSON text
 *   segments: a timestamped transcript [{ start, end, text }] in seconds, saved as JSON text
 */
export const WAVEFORM_BARS = 64;
const MAX_SEGMENTS = 5000;

const _parse = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return null;
  try { const out = JSON.parse(v); return Array.isArray(out) ? out : null; } catch { return null; }
};

/** A waveform (array or JSON text) to a clean array, or null. */
export function parseWaveform(v) {
  const list = _parse(v);
  if (!list || !list.length) return null;
  const bars = list.slice(0, WAVEFORM_BARS).map(n => Math.max(0, Math.min(100, Math.round(Number(n) || 0))));
  return bars.some(b => b > 0) ? bars : null;
}

/** A timestamped transcript (array or JSON text) to clean segments, or null. */
export function parseSegments(v) {
  const list = _parse(v);
  if (!list) return null;
  const out = [];
  for (const s of list.slice(0, MAX_SEGMENTS)) {
    const start = Number(s?.start);
    const text = String(s?.text ?? '').trim().slice(0, 2000);
    if (!Number.isFinite(start) || start < 0 || !text) continue;
    const end = Number(s?.end);
    out.push({ start: Math.round(start * 10) / 10, end: Number.isFinite(end) && end >= start ? Math.round(end * 10) / 10 : null, text });
  }
  return out.length ? out : null;
}

/** For storage: JSON text, or null. */
export const waveformText = (v) => { const w = parseWaveform(v); return w ? JSON.stringify(w) : null; };
export const segmentsText = (v) => { const s = parseSegments(v); return s ? JSON.stringify(s) : null; };

/**
 * How loud a level (0-1 of full scale) looks, as a share of a meter's height.
 *
 * Hearing works in decibels, not in amplitude, so a voice at a tenth of full
 * scale (-20 dB) sounds about half as loud as full but measures a tenth. Read
 * the amplitude straight into bar heights and ordinary speech barely leaves the
 * floor; this maps the quietest level worth seeing to nothing and the loudest
 * to the whole height.
 */
export const METER_FLOOR_DB = -52;
export const METER_TOP_DB = -6;
export function meterLevel(amp, floorDb = METER_FLOOR_DB, topDb = METER_TOP_DB) {
  const a = Number(amp);
  if (!(a > 0)) return 0;
  const db = 20 * Math.log10(Math.min(1, a));
  return Math.max(0, Math.min(1, (db - floorDb) / (topDb - floorDb)));
}

/**
 * Many level samples (0-1) to WAVEFORM_BARS bars, the loudest moment full
 * height and the rest by ear (see meterLevel) rather than by amplitude.
 */
export function barsFromLevels(levels, bars = WAVEFORM_BARS) {
  const list = (levels || []).map(n => Math.max(0, Number(n) || 0));
  if (!list.length) return null;
  const out = [];
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i * list.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * list.length) / bars));
    let peak = 0;
    for (let j = from; j < to && j < list.length; j++) peak = Math.max(peak, list[j]);
    out.push(peak);
  }
  const top = Math.max(...out);
  if (!(top > 0)) return null;
  // 34 dB of range below the loudest moment: quiet speech still has shape,
  // and a room's hiss stays near the floor.
  return out.map(v => Math.max(4, Math.round(meterLevel(v / top, -34, 0) * 100)));
}

/**
 * When a summary is worth asking for. Speech runs about 750 characters a
 * minute, so the two thresholds are the same judgement: half a minute of
 * talking, or the transcript it produces. Below that a summary is as long as
 * the thing it summarises.
 */
export const SUMMARY_MIN_CHARS = 400;
export const SUMMARY_MIN_MS = 30 * 1000;
export const worthSummarizing = (text) => String(text || '').trim().length >= SUMMARY_MIN_CHARS;
export const longEnoughToSummarize = (ms) => Number(ms || 0) >= SUMMARY_MIN_MS;

/** Recordings at least this long can be summarised without being asked. */
export const AUTO_SUMMARY_MS = 10 * 60 * 1000;
