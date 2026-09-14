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

export const TRANSCRIBE_PROMPT = 'Transcribe this audio exactly, in its own language. Reply with only the transcript. If there is no speech, reply NONE.';
export const IMAGE_TEXT_PROMPT = 'Read all the text in this image, in reading order, keeping line breaks. Reply with only the text. If there is no readable text, reply NONE.';

const AUDIO_PROVIDERS = ['openai', 'custom', 'oai-compat', 'gemini'];
const IMAGE_PROVIDERS = ['claude', 'openai', 'custom', 'oai-compat', 'gemini'];

/** { transcribe, readImages }: what the current Trace setup can do. */
export const extractSupport = derived([traceReady, envLocks, aiProvider], ([$ready, $locks, $provider]) => {
  if (!$ready) return { transcribe: false, readImages: false };
  // The server's provider isn't known here; the server answers with an error if it can't.
  if ($locks.ai) return { transcribe: true, readImages: true };
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

export async function transcribeAudio(blob, mime = blob.type || 'audio/webm') {
  if (get(envLocks).ai) {
    const form = new FormData();
    form.append('file', new File([blob], `voice-note.${mime.includes('mp4') ? 'm4a' : 'webm'}`, { type: mime }));
    const res = await fetch(apiUrl('/api/ai/transcribe'), { method: 'POST', credentials: 'include', headers: _authHeaders(), body: form });
    return cleanExtracted((await _json(res, 'Transcription')).text);
  }
  const cfg = _cfg();
  if (!AUDIO_PROVIDERS.includes(cfg.provider)) throw new Error('This AI provider can\'t transcribe audio. Use OpenAI, Gemini, or an OpenAI-compatible Whisper server.');
  if (cfg.provider === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime.split(';')[0], data: await _blobToBase64(blob) } }, { text: TRANSCRIBE_PROMPT }] }] }),
    });
    const data = await _json(res, 'Transcription');
    return cleanExtracted(data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '');
  }
  const base = cfg.provider === 'openai' ? 'https://api.openai.com' : cfg.baseUrl;
  if (!base) throw new Error('Set a Base URL for the OpenAI-compatible provider in Settings, Trace.');
  const form = new FormData();
  form.append('file', new File([blob], `voice-note.${mime.includes('mp4') ? 'm4a' : 'webm'}`, { type: mime }));
  form.append('model', get(aiTranscribeModel) || (cfg.provider === 'openai' ? 'gpt-4o-mini-transcribe' : 'whisper-1'));
  const res = await fetch(`${base}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
    body: form,
  });
  return cleanExtracted((await _json(res, 'Transcription')).text);
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
