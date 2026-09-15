/**
 * transcript.js: timestamped transcripts from the transcription providers,
 * and long recordings in pieces. Pure; shared by the app and the server.
 *
 * Whisper-style services return segments ({ start, end, text } in seconds).
 * Gemini is asked for lines that start with [m:ss]. Everything else gives
 * plain text, which is kept without timestamps.
 */
export const TIMED_TRANSCRIBE_PROMPT = 'Transcribe this audio exactly, in its own language. Put each sentence on its own line, starting with the time it begins in square brackets, like [0:05] or [1:02:10]. Reply with only those lines. If there is no speech, reply NONE.';

/** Upload size a provider takes for one transcription request, in bytes. */
export function transcribeLimitBytes(provider) {
  // OpenAI caps files at 25 MB; Gemini's inline request caps at 20 MB, and base64 grows the file by a third.
  return provider === 'gemini' ? 13 * 1024 * 1024 : 24 * 1024 * 1024;
}

/** Seconds per piece so each stays under the limit, for a file of this size and length. */
export function chunkSeconds(sizeBytes, durationSecs, limitBytes) {
  if (!sizeBytes || !durationSecs) return 10 * 60;
  const perSec = sizeBytes / durationSecs;
  return Math.max(60, Math.min(30 * 60, Math.floor((limitBytes * 0.85) / perSec)));
}

/** Whether a model returns timestamps through verbose_json (Whisper and its look-alikes). */
export const whisperStyle = (model) => !/^gpt-4o/i.test(String(model || ''));

const _clock = (s) => {
  const parts = String(s).split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};

/** "[0:05] Hello there" lines to { text, segments }. Plain text passes through with no segments. */
export function parseTimedText(raw) {
  const lines = String(raw || '').split('\n').map(l => l.trim()).filter(Boolean);
  const segments = [];
  const loose = [];
  for (const line of lines) {
    const m = line.match(/^\[?\(?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\]?\)?\s*[-–:]?\s*(.*)$/);
    const start = m ? _clock(m[1]) : null;
    if (m && start != null && m[2]) segments.push({ start, end: null, text: m[2].trim() });
    else if (segments.length) segments[segments.length - 1].text += ` ${line}`;
    else loose.push(line);
  }
  if (!segments.length) return { text: lines.join('\n'), segments: null };
  for (let i = 0; i < segments.length - 1; i++) segments[i].end = segments[i + 1].start;
  return { text: [...loose, ...segments.map(s => s.text)].join(' ').trim(), segments };
}

/** A Whisper verbose_json reply to { text, segments }. */
export function fromVerboseJson(data) {
  const segments = (data?.segments || [])
    .map(s => ({ start: Number(s.start), end: Number(s.end), text: String(s.text || '').trim() }))
    .filter(s => Number.isFinite(s.start) && s.text);
  return { text: String(data?.text || segments.map(s => s.text).join(' ')).trim(), segments: segments.length ? segments : null };
}

/** Pieces of a long recording ([{ offset, text, segments }]) back into one transcript. */
export function mergePieces(pieces) {
  const texts = [];
  const segments = [];
  let timed = true;
  for (const p of pieces) {
    if (p.text) texts.push(p.text);
    if (p.segments?.length) {
      for (const s of p.segments) {
        segments.push({ start: s.start + (p.offset || 0), end: s.end != null ? s.end + (p.offset || 0) : null, text: s.text });
      }
    } else if (p.text) {
      timed = false;
    }
  }
  return { text: texts.join(' ').trim(), segments: timed && segments.length ? segments : null };
}

/** The segment playing at `secs`, as an index, or -1. */
export function segmentAt(segments, secs) {
  if (!segments?.length) return -1;
  let found = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].start <= secs + 0.05) found = i; else break;
  }
  return found;
}
