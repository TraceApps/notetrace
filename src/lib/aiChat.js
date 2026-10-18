/**
 * AI Chat — multi-provider Trace assistant with tool use (function calling).
 *
 * Mirrors the NutriTrace + LiftTrace pattern so users get a consistent
 * Trace experience across all three apps. Supports Anthropic Claude,
 * OpenAI, Google Gemini, and OpenAI-compatible endpoints (Ollama, LM
 * Studio, vLLM, DeepSeek, Groq, etc.).
 *
 * Tool use flow:
 *   1. Send messages + tool definitions to the model
 *   2. If model responds with tool_use, execute via the registered
 *      handler and feed results back
 *   3. Repeat up to MAX_ROUNDS, then return text
 *
 * The tool catalog is defined alongside the executor in this file
 * (see TOOLS below). Trace.svelte owns the executor implementation
 * via setToolHandler(), keeping the catalog and execution code
 * loosely coupled so we can iterate on either independently.
 */
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { getOpenAIChatParams, openAIBase } from './openai-chat-params.js';
import { createToolSupportMemory, sendWithToolFallback } from './tool-support.js';
import { NOTE_TOOLS } from './trace-note-tools.js';
import { normalizeTokenLimits, applyTokenLimits, openAIAnswer } from './ai-token-limits.js';
import { fetchAIResponse, readAIResponse } from './ai-stream.js';

function localizeTokenError(error) {
  if (error?.code?.startsWith('ai_tokens_')) {
    try { error.message = get(_)(`trace_tokens.errors.${error.code.slice(10)}`); } catch {}
  }
  return error;
}

// ── Provider catalog (kept in NoteTrace's `id`-keyed shape so the
//    existing SettingsTrace dropdown keeps working). ───────────────────────
export const AI_PROVIDERS = [
  { id: 'claude',  label: 'Anthropic Claude' },
  { id: 'openai',  label: 'OpenAI' },
  { id: 'gemini',  label: 'Google Gemini' },
  { id: 'custom',  label: 'OpenAI Compatible' },
];

// Used when no model is chosen. Someone who picked a model keeps it.
export const AI_DEFAULT_MODELS = {
  claude:  'claude-haiku-5-5',
  openai:  'gpt-5.6-luna',
  gemini:  'gemini-3.8-flash',
  custom:  '',
};

// Sentinel appended to each branded provider's model list. When the select
// value is this sentinel, the UI reveals a free-text input so users can
// enter a model ID we haven't hardcoded (e.g. after a vendor renames).
export const AI_MODEL_CUSTOM = '__custom__';

// Checked against the vendors' model and deprecation pages on 2026-10-11
// (platform.claude.com, developers.openai.com, ai.google.dev), the same lists
// as NutriTrace. Labels compare list prices within each provider. A saved
// model that is no longer listed (Gemini 2.5 is open to existing users only)
// keeps working: the picker shows it as a custom model.
// GPT-6.1 Sol and GPT-6 Astra are left out: Trace calls tools through Chat
// Completions, which those two don't support (only the Responses API does).
export const AI_MODELS = {
  claude:  ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', AI_MODEL_CUSTOM],
  openai:  ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-4o-mini', 'gpt-4o', AI_MODEL_CUSTOM],
  gemini:  ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.6-flash', AI_MODEL_CUSTOM],
  custom:  [],
};

/** What a model is called in the picker. Same wording as the other Trace apps. */
export const AI_MODEL_LABELS = {
  'claude-haiku-5-5':          'Claude Haiku 5.5 (fast, cheapest)',
  'claude-sonnet-5-5':         'Claude Sonnet 5.5 (balanced)',
  'claude-opus-5-5':           'Claude Opus 5.5 (smarter)',
  'claude-fable-5-1':          'Claude Fable 5.1 (most capable)',
  'claude-sonnet-5':           'Claude Sonnet 5 (previous)',
  'claude-opus-5':             'Claude Opus 5 (previous)',
  'claude-fable-5':            'Claude Fable 5 (previous)',
  'claude-opus-4-8':           'Claude Opus 4.8 (previous)',
  'gpt-6-luna':                'GPT-6 Luna (fast, cheapest)',
  'gpt-5.6-terra':             'GPT-5.6 Terra (balanced)',
  'gpt-5.6-sol':               'GPT-5.6 Sol (most capable)',
  'gpt-5.6-luna':              'GPT-5.6 Luna (previous)',
  'gpt-4o-mini':               'GPT-4o mini (previous)',
  'gpt-4o':                    'GPT-4o (previous)',
  'gemini-3.1-flash-lite':     'Gemini 3.1 Flash Lite (cheapest)',
  'gemini-3.5-flash-lite':     'Gemini 3.5 Flash Lite (cheap)',
  'gemini-3.8-flash':          'Gemini 3.8 Flash (fast)',
  'gemini-3.1-pro-preview':    'Gemini 3.1 Pro Preview (most capable)',
  'gemini-3.6-flash':          'Gemini 3.6 Flash (previous)',
};

// Model IDs that changed name: a saved old name is sent as the new one.
// gemini-3.1-pro never existed (only the preview does), and Google points
// the shut-down gemini-3-pro-preview at it. gpt-5.6 is the alias of
// gpt-5.6-sol, which the picker now names.
export const AI_MODEL_RENAMES = {
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
  'gpt-5.6': 'gpt-5.6-sol',
};
export const renamedModel = (model) => AI_MODEL_RENAMES[model] || model;

/**
 * The model to send for a saved one, on a vendor's own API: renamed ones by
 * their new name, shut-down Gemini ones as the default. OpenAI-compatible
 * endpoints name their own models, so theirs is sent as saved.
 */
export function modelFor(provider, model) {
  if (provider === 'openai') return renamedModel(model);
  if (provider === 'gemini') return geminiModelFor(model);
  return model;
}

// ── Tool definitions ─────────────────────────────────────────────────────────
// The note tools live in trace-note-tools.js with their executor.
export const TOOLS = NOTE_TOOLS;

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * `relay: true` sends each request through /api/ai/relay, for installs where
 * Trace is set by environment variables: pass the server's provider and
 * model. Tools still run here, on the device, like with a personal key.
 */
// onToolsUnsupported runs when the model can't use tools and answered
// without them (TraceApps/nutritrace#259).
export async function callAI({ provider, apiKey, model, messages, systemPrompt, tools, onToolCall, onToolResult, onToolsUnsupported, onText, baseUrl, relay = false, tokenLimits }) {
  // 'custom' is the legacy NoteTrace name for the same OpenAI-compatible
  // path that NutriTrace calls 'oai-compat'. Both are accepted.
  if (!relay && !apiKey && provider !== 'custom' && provider !== 'oai-compat') {
    throw new Error('No API key configured. Add one in Settings → Trace Assistant.');
  }
  const cb = { onToolCall, onToolResult, onToolsUnsupported, onText, relay };
  if (relay) {
    apiKey = apiKey || 'relay';
    baseUrl = baseUrl || 'relay';
    model = model || AI_DEFAULT_MODELS[provider] || 'relay';
  }
  switch (provider) {
    case 'claude':     return _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, cb);
    case 'openai':     return _callOpenAIWithTools(apiKey, renamedModel(model), messages, systemPrompt, tools, cb, 'https://api.openai.com');
    case 'gemini':     return _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, cb);
    case 'oai-compat':
    case 'custom': {
      const base = relay ? baseUrl : openAIBase(baseUrl);
      if (!base)  throw new Error('OpenAI-compatible provider needs a Base URL. Set one in Settings → Trace.');
      if (!model) throw new Error('OpenAI-compatible provider needs a model name. Set one in Settings → Trace.');
      try {
        cb.tokenLimits = normalizeTokenLimits(tokenLimits);
        return await _callOpenAIWithTools(apiKey || 'no-key', model, messages, systemPrompt, tools, cb, base);
      } catch (e) { throw localizeTokenError(e); }
    }
    default: throw new Error(`Unknown AI provider: ${provider}`);
  }
}

/**
 * fetch() to a provider from this browser. Its "Failed to fetch" says
 * nothing: the browser gives it when the address can't be reached, and when
 * the answer doesn't allow this site to read it (CORS), which is what a proxy
 * that adds CORS headers only to successful answers does to every error,
 * such as a model refusing tools (TraceApps/notetrace#18). Say what to check.
 */
export async function fetchProvider(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    // Only a network failure is reworded (Chrome: "Failed to fetch", Firefox:
    // "NetworkError when attempting to fetch resource.", Safari: "Load
    // failed"). A cancelled request, or one fetch refused to send (a header
    // it can't carry, say), stays as it was.
    if (!(err instanceof TypeError) || !/failed to fetch|networkerror|load failed/i.test(err.message || '')) throw err;
    let host = '';
    try { host = new URL(url).host; } catch { /* not a URL */ }
    host = host || String(url);
    const page = typeof location !== 'undefined' ? location : null;
    const official = /(^|\.)(openai\.com|anthropic\.com|googleapis\.com)$/i.test(host);
    // An https page can't call a plain-http address (localhost aside). The
    // Android app can (allowMixedContent), so there it's the usual advice.
    const native = !!globalThis.Capacitor?.isNativePlatform?.();
    const insecure = !native && page?.protocol === 'https:' && /^http:/i.test(String(url)) && !/^(localhost|127\.|\[::1\])/i.test(host);
    const key = official ? 'unreachable_official' : insecure ? 'unreachable_insecure' : 'unreachable';
    let message = `Couldn't get an answer from ${host}.`;
    try {
      const t = get(_);
      if (typeof t === 'function') message = t(`trace_ai_ct.${key}`, { values: { host, origin: page?.origin || 'this site' } });
    } catch { /* i18n not ready: the plain line above */ }
    const e = new Error(message);
    e.cause = err;
    // Not "you're offline": this says what it is (CookTrace's messages.js
    // would otherwise read words in the host name as a lost connection).
    e.offline = false;
    throw e;
  }
}

/** POST a provider request, directly or through the server relay. */
async function _post(relay, url, headers, body, tokenLimits, onText) {
  if (!relay) {
    if (body.stream) return fetchAIResponse(fetchProvider, url, { method: 'POST', headers, body: JSON.stringify(body) }, { onText });
    const res = await fetchProvider(url, { method: 'POST', headers, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  }
  const { apiUrl, isNative, getServerUrl, getAuthToken } = await import('./platform.js');
  const h = { 'Content-Type': 'application/json' };
  if (isNative && getServerUrl()) {
    const token = getAuthToken();
    if (token) h.Authorization = `Bearer ${token}`;
  } else {
    const csrf = typeof localStorage !== 'undefined' ? localStorage.getItem('note:csrf') : null;
    if (csrf) h['X-CSRF-Token'] = csrf;
  }
  const init = { method: 'POST', credentials: 'include', headers: h, body: JSON.stringify({ body, ...(tokenLimits ? { tokenLimits } : {}) }) };
  const result = body.stream
    ? await fetchAIResponse(fetch, apiUrl('/api/ai/relay'), init, { onText })
    : await readAIResponse(await fetch(apiUrl('/api/ai/relay'), init));
  if (result.status === 401) return { ok: false, status: 401, data: { error: { message: 'Not signed in. Sign in again to use Trace.' } } };
  return result;
}

/** Server-proxy fallback for env-locked installs. Text-only — tools
 *  aren't relayed because the server can't execute client-side. */
export async function callAIProxy({ messages, systemPrompt, tokenLimits }) {
  const { apiUrl, isNative, getServerUrl, getAuthToken } = await import('./platform.js');
  const headers = { 'Content-Type': 'application/json' };
  if (isNative && getServerUrl()) {
    // Native server mode: cookies don't survive WebView reloads, fall back
    // to the same Bearer token api.js uses. Without this, env-locked AI
    // calls return 401 from /api/ai/chat on Android.
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } else {
    const csrf = typeof localStorage !== 'undefined' ? localStorage.getItem('note:csrf') : null;
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(apiUrl('/api/ai/chat'), {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ messages, systemPrompt, tokenLimits, stream: true }),
  });
  const { ok, status, data } = await readAIResponse(res);
  if (!ok) {
    if (status === 401) throw new Error('Not signed in — sign in again to use AI features.');
    throw localizeTokenError(Object.assign(new Error(data.error?.message || data.error || `AI proxy error ${status}`), { code: data.error?.code || data.code }));
  }
  return data.text || data.content || data.message || (data.choices?.[0]?.message?.content) || '';
}

// ── Anthropic Claude (with tool use) ────────────────────────────────────────
async function _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, cb) {
  const { onToolCall, onToolResult } = cb || {};
  const claudeTools = (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
  let currentMessages = [...messages];
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      model: model || AI_DEFAULT_MODELS.claude,
      max_tokens: 4096,
      system: systemPrompt,
      messages: currentMessages,
    };
    if (claudeTools.length) body.tools = claudeTools;
    const res = await _post(cb?.relay, 'https://api.anthropic.com/v1/messages', {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }, body);
    const data = res.data;
    if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);

    const toolUses = (data.content || []).filter(b => b.type === 'tool_use');
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    if (toolUses.length === 0 || data.stop_reason !== 'tool_use') {
      return textBlocks.map(b => b.text).join('\n') || '';
    }
    currentMessages.push({ role: 'assistant', content: data.content });
    const toolResults = [];
    for (const tu of toolUses) {
      if (onToolCall) onToolCall(tu.name, tu.input);
      const result = await _executeTool(tu.name, tu.input);
      if (onToolResult) onToolResult(tu.name, result);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    currentMessages.push({ role: 'user', content: toolResults });
  }
  throw new Error('Too many tool call rounds');
}

// ── OpenAI / OpenAI-compatible ─────────────────────────────────────────────
// Models found unable to use tools, by base URL and model (TraceApps/nutritrace#259).
const toolSupport = createToolSupportMemory();

async function _callOpenAIWithTools(apiKey, model, messages, systemPrompt, tools, cb, baseUrl = 'https://api.openai.com') {
  const { onToolCall, onToolResult, onToolsUnsupported } = cb || {};
  const openaiTools = (tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  let currentMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const selectedModel = model || AI_DEFAULT_MODELS.openai;
    const body = {
      model: selectedModel,
      messages: currentMessages,
      ...getOpenAIChatParams({
        baseUrl,
        model: selectedModel,
        hasTools: openaiTools.length > 0,
        maxTokens: cb?.tokenLimits?.maxTokens,
      }),
    };
    if (openaiTools.length) body.tools = openaiTools;
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (cb?.tokenLimits) {
      body.stream = true;
      headers.Accept = 'text/event-stream, application/json';
    }
    if (apiKey && apiKey !== 'no-key') headers['Authorization'] = `Bearer ${apiKey}`;
    const send = (b) => {
      cb?.onText?.('', true);
      return _post(cb?.relay, `${baseUrl}/v1/chat/completions`, headers, cb?.tokenLimits ? applyTokenLimits(b, cb.tokenLimits) : b, cb?.tokenLimits, cb?.onText);
    };
    // A model that can't use tools gets the request again without them.
    // Through the relay the server may already have done that (it says so
    // with trace_tools_unsupported).
    const { ok, status, data, toolsDropped, toolsRouted } = await sendWithToolFallback(body, send, { memory: toolSupport, baseUrl, model: selectedModel });
    if (!ok) throw Object.assign(new Error(data.error?.message || `AI API error ${status}`), { code: data.error?.code });
    if (toolsDropped || data.trace_tools_unsupported) onToolsUnsupported?.({ routed: toolsRouted || !!data.trace_tools_routed });

    const msg = cb?.tokenLimits ? openAIAnswer(data) : data.choices[0].message;
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || '';
    }
    // Validate the whole group before any write tool can execute.
    const calls = msg.tool_calls.map(tc => {
      if (!tc.id || !tc.function?.name) throw new Error('The AI returned an incomplete tool call. Please retry.');
      const args = JSON.parse(tc.function.arguments || '{}');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('The AI returned invalid tool arguments. Please retry.');
      return { tc, args };
    });
    cb?.onText?.('', true);
    currentMessages.push(msg);
    for (const { tc, args } of calls) {
      if (onToolCall) onToolCall(tc.function.name, args);
      const result = await _executeTool(tc.function.name, args);
      if (onToolResult) onToolResult(tc.function.name, result);
      currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  throw new Error('Too many tool call rounds');
}

// ── Google Gemini ──────────────────────────────────────────────────────────
// Models Google has shut down. Saved selections pointing at any of these are
// quietly remapped to the current default so users who never opened Settings
// after a bump don't suddenly hit 404s.
// Shut down per ai.google.dev/gemini-api/docs/deprecations (2026-10-09).
export const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite', 'gemini-2.0-flash-lite-001',
  'gemini-2.0-flash-lite-preview', 'gemini-2.0-flash-lite-preview-02-05',
  'gemini-2.5-pro-preview-03-25', 'gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro-preview-06-05',
  'gemini-2.5-flash-preview-05-20', 'gemini-2.5-flash-preview-09-25', 'gemini-2.5-flash-lite-preview-09-2025',
  'gemini-3.1-flash-lite-preview',
]);
/** The Gemini model to call for a saved one: renamed ones by their new name, shut-down ones by the default. */
export function geminiModelFor(model) {
  const m = renamedModel(model || AI_DEFAULT_MODELS.gemini);
  return GEMINI_RETIRED.has(m) ? AI_DEFAULT_MODELS.gemini : m;
}

async function _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, cb) {
  const { onToolCall, onToolResult } = cb || {};
  const m = geminiModelFor(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const geminiTools = (tools || []).length ? [{
    // Gemini refuses an OBJECT schema with no properties, so leave it out.
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      ...(Object.keys(t.parameters?.properties || {}).length ? { parameters: t.parameters } : {}),
    })),
  }] : undefined;

  let contents = messages.map(msg => {
    const parts = [];
    if (msg._image) {
      parts.push({ inlineData: { mimeType: msg._image.mimeType, data: msg._image.base64 } });
    }
    parts.push({ text: typeof msg.content === 'string' ? msg.content : (msg.content || '') });
    return { role: msg.role === 'assistant' ? 'model' : 'user', parts };
  });

  const MAX_ROUNDS = 5;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
    };
    if (geminiTools) body.tools = geminiTools;
    const res = await _post(cb?.relay, url, { 'Content-Type': 'application/json' }, body);
    const data = res.data;
    if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);
    const textParts = parts.filter(p => p.text);
    if (functionCalls.length === 0) {
      return textParts.map(p => p.text).join('\n') || '';
    }
    contents.push({ role: 'model', parts });
    const responseParts = [];
    for (const fc of functionCalls) {
      if (onToolCall) onToolCall(fc.functionCall.name, fc.functionCall.args || {});
      const result = await _executeTool(fc.functionCall.name, fc.functionCall.args || {});
      if (onToolResult) onToolResult(fc.functionCall.name, result);
      responseParts.push({ functionResponse: { name: fc.functionCall.name, response: result } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  throw new Error('Too many tool call rounds');
}

// ── Tool execution ──────────────────────────────────────────────────────────
let _toolHandler = null;
export function setToolHandler(handler) { _toolHandler = handler; }

async function _executeTool(name, args) {
  if (!_toolHandler) return { error: 'Tool handler not registered' };
  try {
    return await _toolHandler(name, args);
  } catch (e) {
    return { error: e.message || 'Tool execution failed' };
  }
}
