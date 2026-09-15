/**
 * ai-extract.js: voice note transcription and reading text in images with
 * the server's AI provider, for installs where Trace is set by environment
 * variables (AI_PROVIDER / AI_API_KEY). Otherwise the browser or phone calls
 * the user's own provider directly (src/lib/ai-extract.js); the prompts and
 * provider support match.
 *
 *   transcription: OpenAI, OpenAI-compatible (a Whisper server), Gemini
 *   image text:    Claude, OpenAI, OpenAI-compatible (vision model), Gemini
 */

import fs from 'node:fs';
import path from 'node:path';
import { TIMED_TRANSCRIBE_PROMPT, parseTimedText, fromVerboseJson, mergePieces, whisperStyle, transcribeLimitBytes, chunkSeconds } from './transcript.js';
import { splitAudio, probeDurationMs } from './audio-tools.js';

export const TRANSCRIBE_PROMPT = 'Transcribe this audio exactly, in its own language. Reply with only the transcript. If there is no speech, reply NONE.';
export const IMAGE_TEXT_PROMPT = 'Read all the text in this image, in reading order, keeping line breaks. Reply with only the text. If there is no readable text, reply NONE.';

export function canTranscribe(provider) {
  return ['openai', 'oai-compat', 'custom', 'gemini'].includes(provider);
}
export function canReadImages(provider) {
  return ['claude', 'openai', 'oai-compat', 'custom', 'gemini'].includes(provider);
}

/** A reply of NONE (or nothing) means there was nothing to extract. */
export function cleanExtracted(text) {
  const s = String(text || '').trim().replace(/^```[a-z]*\n?|\n?```$/gi, '').trim();
  return /^none\.?$/i.test(s) ? '' : s;
}

async function _json(res, what) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.error || `${what} failed (${res.status})`);
  return data;
}

/** One request's worth of audio to { text, segments } (segments when the provider gives times). */
export async function transcribeAudio(cfg, { buffer, mime, filename = 'voice-note.webm' }) {
  const provider = cfg.provider;
  if (!canTranscribe(provider)) throw new Error('This AI provider can\'t transcribe audio. Use OpenAI, Gemini, or an OpenAI-compatible Whisper server.');
  if (provider === 'gemini') {
    const model = cfg.model || 'gemini-3.6-flash';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime, data: Buffer.from(buffer).toString('base64') } }, { text: TIMED_TRANSCRIBE_PROMPT }] }] }),
    });
    const data = await _json(res, 'Transcription');
    const raw = cleanExtracted(data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '');
    return raw ? parseTimedText(raw) : { text: '', segments: null };
  }
  const base = provider === 'openai' ? 'https://api.openai.com' : String(cfg.baseUrl || '').replace(/\/+$/, '');
  const model = cfg.transcribeModel || (provider === 'openai' ? 'gpt-4o-mini-transcribe' : 'whisper-1');
  const headers = cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
  const send = async (timed) => {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), filename);
    form.append('model', model);
    if (timed) { form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'segment'); }
    else if (provider === 'openai') form.append('chunking_strategy', 'auto');
    return fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers, body: form });
  };
  const timed = whisperStyle(model);
  let res = await send(timed);
  // Some Whisper servers don't take verbose_json; plain text still works.
  if (timed && res.status === 400) res = await send(false);
  const data = await _json(res, 'Transcription');
  const r = data.segments ? fromVerboseJson(data) : { text: String(data.text || ''), segments: null };
  const text = cleanExtracted(r.text);
  return text ? { text, segments: r.segments } : { text: '', segments: null };
}

/**
 * A voice note file on the server to { text, segments }. Recordings bigger than
 * the provider takes in one request are split with ffmpeg and joined back up.
 */
export async function transcribeFile(cfg, file, { mime, splitDir }) {
  const size = fs.statSync(file).size;
  const limit = transcribeLimitBytes(cfg.provider);
  if (size <= limit) return transcribeAudio(cfg, { buffer: fs.readFileSync(file), mime, filename: path.basename(file) });
  const durationMs = await probeDurationMs(file);
  const pieces = await splitAudio(file, chunkSeconds(size, (durationMs || 0) / 1000, limit), splitDir);
  if (!pieces) throw new Error('This recording is too long to transcribe in one request, and this server can\'t split audio.');
  const out = [];
  try {
    for (const p of pieces) {
      const pieceMime = /\.m4a$|\.mp4$/i.test(p.file) ? 'audio/mp4' : mime;
      out.push({ offset: p.offset, ...(await transcribeAudio(cfg, { buffer: fs.readFileSync(p.file), mime: pieceMime, filename: path.basename(p.file) })) });
    }
  } finally {
    pieces.forEach(p => { try { fs.unlinkSync(p.file); } catch { /* gone */ } });
  }
  return mergePieces(out);
}

export async function readImageText(cfg, { base64, mime }) {
  const provider = cfg.provider;
  if (!canReadImages(provider)) throw new Error('This AI provider can\'t read images.');
  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.model, max_tokens: 2000,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data: base64 } }, { type: 'text', text: IMAGE_TEXT_PROMPT }] }],
      }),
    });
    const data = await _json(res, 'Reading the image');
    return cleanExtracted(data.content?.map(c => c.text || '').join('') || '');
  }
  if (provider === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: IMAGE_TEXT_PROMPT }] }] }),
    });
    const data = await _json(res, 'Reading the image');
    return cleanExtracted(data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '');
  }
  const base = provider === 'openai' ? 'https://api.openai.com' : String(cfg.baseUrl || '').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) };
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }, { type: 'text', text: IMAGE_TEXT_PROMPT }] }],
    }),
  });
  const data = await _json(res, 'Reading the image');
  return cleanExtracted(data.choices?.[0]?.message?.content || '');
}
