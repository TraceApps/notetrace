/**
 * ai-extract.js: transcribe voice notes and read text in images with Trace.
 *
 * Calls the user's own provider from the browser or phone, like the Trace
 * chat does. When Trace is set by environment variables it goes through
 * the server instead (/api/ai/transcribe, /api/ai/read-image). The result
 * is saved on the attachment (extracted_text), where search picks it up.
 *
 *   transcription: OpenAI, OpenAI-compatible (a Whisper server), Gemini
 *   image text:    Claude, OpenAI, OpenAI-compatible (vision model), Gemini
 */
import { get, derived } from 'svelte/store';
import { aiProvider, aiApiKey, aiModel, aiBaseUrl, envLocks, aiTranscribeModel } from '../stores/settings.js';
import { traceReady } from './trace-run.js';
import { apiUrl, isNative, getServerUrl, getAuthToken, resolveAssetUrl } from './platform.js';
import { AI_DEFAULT_MODELS } from './aiChat.js';
import { TIMED_TRANSCRIBE_PROMPT, parseTimedText, fromVerboseJson, mergePieces, whisperStyle, transcribeLimitBytes, chunkSeconds } from '../../server/lib/transcript.js';

export const TRANSCRIBE_PROMPT = 'Transcribe this audio exactly, in its own language. Reply with only the transcript. If there is no speech, reply NONE.';
export const IMAGE_TEXT_PROMPT = 'Read all the text in this image, in reading order, keeping line breaks. Reply with only the text. If there is no readable text, reply NONE.';

const AUDIO_PROVIDERS = ['openai', 'custom', 'oai-compat', 'gemini'];
const IMAGE_PROVIDERS = ['claude', 'openai', 'custom', 'oai-compat', 'gemini'];

/** { transcribe, readImages }: what the current Trace setup can do. */
export const extractSupport = derived([traceReady, envLocks, aiProvider], ([$ready, $locks, $provider]) => {
  if (!$ready) return { transcribe: false, readImages: false };
  if ($locks.ai) return { transcribe: !!$locks.ai_transcribe, readImages: !!$locks.ai_read_images };
  return { transcribe: AUDIO_PROVIDERS.includes($provider), readImages: IMAGE_PROVIDERS.includes($provider) };
});

export function cleanExtracted(text) {
  const s = String(text || '').trim().replace(/^```[a-z]*\n?|\n?```$/gi, '').trim();
  return /^none\.?$/i.test(s) ? '' : s;
}

function _authHeaders() {
  if (isNative && getServerUrl()) {
    const t = getAuthToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }
  const csrf = localStorage.getItem('note:csrf');
  return csrf ? { 'X-CSRF-Token': csrf } : {};
}

async function _json(res, what) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.error || `${what} failed (${res.status})`);
  return data;
}

const _cfg = () => {
  const provider = get(aiProvider);
  return { provider, apiKey: get(aiApiKey), model: get(aiModel) || AI_DEFAULT_MODELS[provider] || '', baseUrl: String(get(aiBaseUrl) || '').replace(/\/+$/, '') };
};

async function _blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Fetch an attachment's file (server upload or a file on this device). */
export async function fetchAttachmentBlob(url) {
  const res = await fetch(resolveAssetUrl(url), { credentials: 'include' });
  if (!res.ok) throw new Error(`Couldn't load the file (${res.status})`);
  return res.blob();
}

const _audioExt = (mime) => (mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : 'webm');

/** One request's worth of audio to { text, segments } with the user's own provider. */
async function _transcribePiece(blob, mime) {
  const cfg = _cfg();
  if (!AUDIO_PROVIDERS.includes(cfg.provider)) throw new Error('This AI provider can\'t transcribe audio. Use OpenAI, Gemini, or an OpenAI-compatible Whisper server.');
  if (cfg.provider === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime.split(';')[0], data: await _blobToBase64(blob) } }, { text: TIMED_TRANSCRIBE_PROMPT }] }] }),
    });
    const data = await _json(res, 'Transcription');
    const raw = cleanExtracted(data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '');
    return raw ? parseTimedText(raw) : { text: '', segments: null };
  }
  const base = cfg.provider === 'openai' ? 'https://api.openai.com' : cfg.baseUrl;
  if (!base) throw new Error('Set a Base URL for the OpenAI-compatible provider in Settings, Trace.');
  const model = get(aiTranscribeModel) || (cfg.provider === 'openai' ? 'gpt-4o-mini-transcribe' : 'whisper-1');
  const send = (timed) => {
    const form = new FormData();
    form.append('file', new File([blob], `voice-note.${_audioExt(mime)}`, { type: mime }));
    form.append('model', model);
    // Whisper-style models give times per sentence; the gpt-4o ones only text.
    if (timed) { form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'segment'); }
    else if (cfg.provider === 'openai') form.append('chunking_strategy', 'auto');
    return fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}, body: form });
  };
  const timed = whisperStyle(model);
  let res = await send(timed);
  if (timed && res.status === 400) res = await send(false);
  const data = await _json(res, 'Transcription');
  const r = data.segments ? fromVerboseJson(data) : { text: String(data.text || ''), segments: null };
  const text = cleanExtracted(r.text);
  return text ? { text, segments: r.segments } : { text: '', segments: null };
}

const _serverUpload = (url) => /^\/uploads\/[A-Za-z0-9._-]+$/.test(String(url || '')) && (!isNative || !!getServerUrl());

/**
 * Transcribe a voice note: { text, segments } (segments when the provider gives
 * times). A recording too big for one request is split by the server and
 * transcribed in pieces.
 */
export async function transcribeVoiceNote(att, blob = null) {
  const mime = String(att?.mime || blob?.type || 'audio/webm').split(';')[0];
  if (get(envLocks).ai) {
    if (_serverUpload(att?.url)) {
      const res = await fetch(apiUrl('/api/ai/transcribe'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ..._authHeaders() },
        body: JSON.stringify({ url: att.url, mime }),
      });
      return _json(res, 'Transcription');
    }
    const file = blob || await fetchAttachmentBlob(att.url);
    const form = new FormData();
    form.append('file', new File([file], `voice-note.${_audioExt(mime)}`, { type: mime }));
    const res = await fetch(apiUrl('/api/ai/transcribe'), { method: 'POST', credentials: 'include', headers: _authHeaders(), body: form });
    return _json(res, 'Transcription');
  }
  const file = blob || await fetchAttachmentBlob(att.url);
  const limit = transcribeLimitBytes(_cfg().provider);
  if (file.size <= limit) return _transcribePiece(file, mime);
  if (!_serverUpload(att?.url)) {
    // No server: the Android app can cut its own M4A recordings into pieces.
    const { splitRecordingOnDevice } = await import('./voice-recorder.js');
    const parts = await splitRecordingOnDevice(resolveAssetUrl(att.url), chunkSeconds(file.size, (att.duration_ms || 0) / 1000, limit)).catch(() => null);
    if (!parts?.length) throw new Error('This recording is too long to transcribe in one request.');
    const out = [];
    for (const p of parts) out.push({ offset: p.offset, ...(await _transcribePiece(p.blob, 'audio/mp4')) });
    return mergePieces(out);
  }
  const seconds = chunkSeconds(file.size, (att.duration_ms || 0) / 1000, limit);
  const res = await fetch(apiUrl('/api/upload/split'), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', ..._authHeaders() },
    body: JSON.stringify({ url: att.url, seconds }),
  });
  const { pieces } = await _json(res, 'Splitting the recording');
  const out = [];
  for (const p of pieces) {
    const part = await fetchAttachmentBlob(p.url);
    out.push({ offset: p.offset, ...(await _transcribePiece(part, /\.m4a$/i.test(p.url) ? 'audio/mp4' : mime)) });
  }
  return mergePieces(out);
}

/** Plain transcript text for a recording within one request's size. */
export async function transcribeAudio(blob, mime = blob.type || 'audio/webm') {
  return (await transcribeVoiceNote({ mime }, blob)).text;
}

/** Downscale for reading (text stays legible at 1600px) and encode as JPEG. */
async function _imageForReading(blob) {
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const out = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (out) return { base64: await _blobToBase64(out), mime: 'image/jpeg' };
  } catch { /* send as-is */ }
  return { base64: await _blobToBase64(blob), mime: blob.type || 'image/jpeg' };
}

export async function readImageText(blob) {
  const { base64, mime } = await _imageForReading(blob);
  if (get(envLocks).ai) {
    const res = await fetch(apiUrl('/api/ai/read-image'), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ base64, mime }),
    });
    return cleanExtracted((await _json(res, 'Reading the image')).text);
  }
  const cfg = _cfg();
  if (!IMAGE_PROVIDERS.includes(cfg.provider)) throw new Error('This AI provider can\'t read images.');
  if (cfg.provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: cfg.model, max_tokens: 2000, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data: base64 } }, { type: 'text', text: IMAGE_TEXT_PROMPT }] }] }),
    });
    const data = await _json(res, 'Reading the image');
    return cleanExtracted(data.content?.map(c => c.text || '').join('') || '');
  }
  if (cfg.provider === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: IMAGE_TEXT_PROMPT }] }] }),
    });
    const data = await _json(res, 'Reading the image');
    return cleanExtracted(data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '');
  }
  const base = cfg.provider === 'openai' ? 'https://api.openai.com' : cfg.baseUrl;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }, { type: 'text', text: IMAGE_TEXT_PROMPT }] }] }),
  });
  const data = await _json(res, 'Reading the image');
  return cleanExtracted(data.choices?.[0]?.message?.content || '');
}

export const isAudio = (a) => /^audio\//i.test(String(a?.mime || '')) || /\.(webm|ogg|m4a|mp3|wav|aac)$/i.test(String(a?.url || ''));
export const isImage = (a) => !isAudio(a) && (/^image\//i.test(String(a?.mime || '')) || !a?.mime);

/**
 * A short summary of a voice note, from its transcript. Transcribes first when
 * there's nothing to summarise yet, so one press is enough on a recording that
 * has never been through Trace.
 *
 * `onStep` is called with 'transcribing' or 'summarizing' for the progress line.
 * Resolves { summary, text, segments }: text and segments are set only when
 * this call did the transcribing.
 */
export async function summarizeVoiceNote(att, blob = null, { onStep = () => {} } = {}) {
  let text = att?.extracted_text || '';
  let segments = null;
  let transcribed = false;
  if (!text.trim()) {
    onStep('transcribing');
    const r = await transcribeVoiceNote(att, blob);
    text = r?.text || '';
    segments = r?.segments || null;
    transcribed = true;
    if (!text.trim()) return { summary: '', text: '', segments: null };
  }
  onStep('summarizing');
  const { askTrace, TRACE_ACTIONS, cleanTraceReply } = await import('./trace-run.js');
  const a = TRACE_ACTIONS.recap;
  const summary = cleanExtracted(cleanTraceReply(await askTrace({ systemPrompt: a.system, prompt: a.prompt('', text) })));
  return transcribed ? { summary, text, segments } : { summary, text: '', segments: null };
}
