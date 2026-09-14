import { Router } from 'express';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { wrap } from '../logger.js';
import { getAiConfig } from '../ai.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';
import { getOpenAIChatParams } from '../lib/openai-chat-params.js';
import db from '../db.js';
import multer from 'multer';
import { transcribeAudio, readImageText } from '../lib/ai-extract.js';

const router = Router();
const aiChatLimit = makeRateLimiter({ max: 30, windowMs: 60_000, label: 'ai' });

const uid = req => userMgmtActive() ? req.user.id : null;
const MAX_HISTORY = 200; // rows kept per user

// ── GET /api/ai/history ───────────────────────────────────────────────────────
router.get('/history', requireAuth, wrap((req, res) => {
  const u = uid(req);
  const rows = u == null
    ? db.prepare(`SELECT role, content, created_at FROM ai_chat_history WHERE user_id IS NULL ORDER BY created_at ASC LIMIT 100`).all()
    : db.prepare(`SELECT role, content, created_at FROM ai_chat_history WHERE user_id = ? ORDER BY created_at ASC LIMIT 100`).all(u);
  res.json(rows);
}));

// ── POST /api/ai/history ──────────────────────────────────────────────────────
router.post('/history', requireAuth, wrap((req, res) => {
  const { role, content } = req.body;
  if (!role || !content) return res.status(400).json({ error: 'role and content required' });
  const u = uid(req);

  if (u == null) {
    db.prepare(`INSERT INTO ai_chat_history (user_id, role, content) VALUES (NULL, ?, ?)`).run(role, content);
    // Trim oldest beyond MAX_HISTORY
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id IS NULL AND id NOT IN (SELECT id FROM ai_chat_history WHERE user_id IS NULL ORDER BY created_at DESC LIMIT ?)`).run(MAX_HISTORY);
  } else {
    db.prepare(`INSERT INTO ai_chat_history (user_id, role, content) VALUES (?, ?, ?)`).run(u, role, content);
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id = ? AND id NOT IN (SELECT id FROM ai_chat_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`).run(u, u, MAX_HISTORY);
  }
  res.json({ ok: true });
}));

// ── DELETE /api/ai/history ────────────────────────────────────────────────────
router.delete('/history', requireAuth, wrap((req, res) => {
  const u = uid(req);
  if (u == null) {
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id IS NULL`).run();
  } else {
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id = ?`).run(u);
  }
  res.json({ ok: true });
}));

const AI_DEFAULT_MODELS = {
  claude: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5.6-luna',
  gemini: 'gemini-3.6-flash',
};

// Models Google has shut down (404) or scheduled for shutdown.
// Saved env-locked configs pointing at any of these are remapped to the
// current default so the proxy doesn't 404 against a dead endpoint.
const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-lite',
]);

/**
 * POST /api/ai/chat
 * Server-side proxy for AI calls — used when AI config is env-locked.
 * The API key never leaves the server; clients send only messages + systemPrompt.
 */
// Payload caps to bound a misbehaving client (or compromised account) from
// burning through the admin's AI API budget with one giant request.
const AI_MAX_MESSAGES   = 60;
const AI_MAX_BYTES      = 200_000; // ~200 KB combined messages + system prompt

// Normalise any image content part on an incoming message to the OpenAI
// wire shape `{type:'image_url', image_url:{url:'data:...'}}` so the
// oai-compat forward path never sees Anthropic-shape (which LiteLLM /
// strict schema proxies reject with `invalid content type=image`).
// Idempotent; non-array content untouched. Defense-in-depth against
// NT #114-class client drift.
function _normaliseImagePartsToOpenAI(msg) {
  if (!msg || !Array.isArray(msg.content)) return msg;
  const normalised = msg.content.map(part => {
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'image' && part.source?.type === 'base64' && part.source.media_type && part.source.data) {
      return {
        type: 'image_url',
        image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` },
      };
    }
    if (part.type === 'image' && typeof part.dataUrl === 'string') {
      return { type: 'image_url', image_url: { url: part.dataUrl } };
    }
    return part;
  });
  return { ...msg, content: normalised };
}

// Transcription and image text through the server's provider, for installs
// where Trace is set by environment variables. The browser calls the user's
// own provider directly otherwise (src/lib/ai-extract.js).
function _serverCfg() {
  const cfg = getAiConfig();
  const provider = cfg.ai_provider || 'claude';
  return {
    provider,
    apiKey: cfg.ai_api_key,
    model: cfg.ai_model || AI_DEFAULT_MODELS[provider] || '',
    baseUrl: cfg.ai_base_url,
    transcribeModel: process.env.AI_TRANSCRIBE_MODEL || '',
  };
}
const _audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/transcribe', requireAuth, aiChatLimit, (req, res, next) => {
  _audioUpload.single('file')(req, res, async (err) => {
    try {
      if (err) return res.status(413).json({ error: 'Voice notes up to 25 MB can be transcribed.' });
      if (!req.file || !/^audio\//.test(req.file.mimetype)) return res.status(400).json({ error: 'An audio file is required' });
      const text = await transcribeAudio(_serverCfg(), { buffer: req.file.buffer, mime: req.file.mimetype, filename: req.file.originalname || 'voice-note.webm' });
      res.json({ text });
    } catch (e) {
      res.status(502).json({ error: e.message || 'Transcription failed' });
    }
  });
});

// ── POST /api/ai/relay ────────────────────────────────────────────────────────
// Trace's tool loop when Trace is set by environment variables. The client
// builds the provider's own request (tools and all) and runs the tools on
// the device, exactly as with a personal key; the server only adds the key,
// forces the configured model, and forwards to the configured provider.
// Body fields are allowlisted per provider and token limits are capped.
const RELAY_FIELDS = {
  claude: ['system', 'messages', 'tools', 'tool_choice', 'max_tokens'],
  openai: ['messages', 'tools', 'tool_choice', 'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'temperature'],
  gemini: ['systemInstruction', 'contents', 'tools', 'toolConfig', 'generationConfig'],
};
const RELAY_MAX_TOKENS = 8192;

export function relayRequest(cfg, body) {
  const kind = cfg.provider === 'claude' ? 'claude' : cfg.provider === 'gemini' ? 'gemini' : 'openai';
  const out = {};
  for (const k of RELAY_FIELDS[kind]) if (body[k] !== undefined) out[k] = body[k];
  for (const k of ['max_tokens', 'max_completion_tokens']) {
    if (out[k] !== undefined) out[k] = Math.min(RELAY_MAX_TOKENS, Math.max(1, Number(out[k]) || 1024));
  }
  if (kind === 'claude') {
    out.model = cfg.model;
    out.max_tokens = out.max_tokens || 4096;
    return { url: 'https://api.anthropic.com/v1/messages', headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }, body: out };
  }
  if (kind === 'gemini') {
    return { url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey || '')}`, headers: { 'Content-Type': 'application/json' }, body: out };
  }
  out.model = cfg.model;
  const base = cfg.provider === 'openai' ? 'https://api.openai.com' : String(cfg.baseUrl || '').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  return { url: `${base}/v1/chat/completions`, headers, body: out };
}

router.post('/relay', requireAuth, aiChatLimit, wrap(async (req, res) => {
  const body = req.body?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: { message: 'body object required' } });
  const cfg = _serverCfg();
  const local = cfg.provider === 'oai-compat' || cfg.provider === 'custom';
  if (!cfg.apiKey && !local) return res.status(503).json({ error: { message: 'AI not configured on server. Set AI_API_KEY in environment.' } });
  if (local && (!cfg.baseUrl || !cfg.model)) return res.status(503).json({ error: { message: 'AI_PROVIDER=oai-compat requires AI_BASE_URL and AI_MODEL in environment.' } });
  const r = relayRequest(cfg, body);
  let upstream;
  try {
    upstream = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    return res.status(502).json({ error: { message: e?.name === 'TimeoutError' ? 'The AI provider didn\'t answer in time.' : 'Couldn\'t reach the AI provider.' } });
  }
  const data = await upstream.json().catch(() => ({ error: { message: `AI provider error ${upstream.status}` } }));
  res.status(upstream.status).json(data);
}));

router.post('/read-image', requireAuth, aiChatLimit, wrap(async (req, res) => {
  const { base64, mime } = req.body || {};
  if (typeof base64 !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(String(mime))) return res.status(400).json({ error: 'base64 and an image mime are required' });
  try {
    res.json({ text: await readImageText(_serverCfg(), { base64, mime }) });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Reading the image failed' });
  }
}));

router.post('/chat', requireAuth, aiChatLimit, wrap(async (req, res) => {
  const { messages: rawMessages, systemPrompt } = req.body;
  if (!Array.isArray(rawMessages)) return res.status(400).json({ error: 'messages array required' });
  const messages = rawMessages.map(_normaliseImagePartsToOpenAI);
  if (messages.length > AI_MAX_MESSAGES) {
    return res.status(413).json({ error: `Too many messages (max ${AI_MAX_MESSAGES})` });
  }
  const payloadBytes = JSON.stringify(messages).length + (typeof systemPrompt === 'string' ? systemPrompt.length : 0);
  if (payloadBytes > AI_MAX_BYTES) {
    return res.status(413).json({ error: `Payload too large (${payloadBytes} bytes; max ${AI_MAX_BYTES})` });
  }

  const cfg = getAiConfig();
  const provider = cfg.ai_provider || 'claude';
  const model    = cfg.ai_model    || AI_DEFAULT_MODELS[provider] || '';
  const apiKey   = cfg.ai_api_key;
  const baseUrl  = cfg.ai_base_url;

  // API key required for cloud providers; oai-compat local endpoints
  // (Ollama, LM Studio, etc.) often don't need one — mirror callAI().
  if (!apiKey && provider !== 'oai-compat') {
    return res.status(503).json({ error: 'AI not configured on server. Set AI_API_KEY in environment.' });
  }
  if (provider === 'oai-compat') {
    if (!baseUrl) return res.status(503).json({ error: 'AI_PROVIDER=oai-compat requires AI_BASE_URL in environment.' });
    if (!model)   return res.status(503).json({ error: 'AI_PROVIDER=oai-compat requires AI_MODEL in environment.' });
  }

  let text;
  switch (provider) {
    case 'claude':     text = await _callClaude(apiKey, model, messages, systemPrompt); break;
    case 'openai':     text = await _callOpenAI(apiKey, model, messages, systemPrompt, 'https://api.openai.com'); break;
    case 'gemini':     text = await _callGemini(apiKey, model, messages, systemPrompt); break;
    case 'oai-compat': text = await _callOpenAI(apiKey || 'no-key', model, messages, systemPrompt, baseUrl.replace(/\/+$/, '')); break;
    default: return res.status(400).json({ error: `Unknown provider: ${provider}` });
  }
  res.json({ text });
}));

export default router;

// ── Provider implementations (server-side) ────────────────────────────────────

async function _callClaude(apiKey, model, messages, systemPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);
  return data.content[0].text;
}

async function _callOpenAI(apiKey, model, messages, systemPrompt, baseUrl = 'https://api.openai.com') {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      ...getOpenAIChatParams({ baseUrl, model, hasTools: false, maxTokens: 1024 }),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI API error ${res.status}`);
  return data.choices[0].message.content;
}

async function _callGemini(apiKey, model, messages, systemPrompt) {
  const m = GEMINI_RETIRED.has(model) ? AI_DEFAULT_MODELS.gemini : (model || AI_DEFAULT_MODELS.gemini);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);
  return data.candidates[0].content.parts[0].text;
}
