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

export async function transcribeAudio(cfg, { buffer, mime, filename = 'voice-note.webm' }) {
  const provider = cfg.provider;
  if (!canTranscribe(provider)) throw new Error('This AI provider can\'t transcribe audio. Use OpenAI, Gemini, or an OpenAI-compatible Whisper server.');
  if (provider === 'gemini') {
    const model = cfg.model || 'gemini-3.6-flash';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime, data: Buffer.from(buffer).toString('base64') } }, { text: TRANSCRIBE_PROMPT }] }] }),
    });
    const data = await _json(res, 'Transcription');
    return cleanExtracted(data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '');
  }
  const base = provider === 'openai' ? 'https://api.openai.com' : String(cfg.baseUrl || '').replace(/\/+$/, '');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  form.append('model', cfg.transcribeModel || (provider === 'openai' ? 'gpt-4o-mini-transcribe' : 'whisper-1'));
  const headers = cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
  const res = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers, body: form });
  const data = await _json(res, 'Transcription');
  return cleanExtracted(data.text || '');
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
