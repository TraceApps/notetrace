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
 *   3. Repeat up to TOOL_ROUNDS; when they run out, one last request
 *      with the tools off asks for an answer from what was found
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
import { geminiToolResponse } from './gemini-tool-response.js';
import { REPLY_MAX_TOKENS, sendWithLengthFallback, stoppedShort, stoppedShortError } from './trace-reply.js';

// A reply that stopped short, said in the app's language (trace-reply.js).
function _inLanguage(e) {
  if (!/^trace_stopped_/.test(e?.code || '')) return e;
  try {
    const t = get(_);
    const said = typeof t === 'function' ? t(`trace_reply.${e.code.slice('trace_'.length)}`) : null;
    if (said && !said.startsWith('trace_reply.')) e.message = said;
  } catch { /* i18n not ready: the English line */ }
  return e;
}
const _stoppedShort = (why) => _inLanguage(stoppedShortError(why));

// The last round's answer, or, when a model gave none at all, why there's none.
function _finalAnswer(text) {
  if (String(text || '').trim()) return text;
  try {
    const said = get(_)('trace_reply.out_of_rounds');
    if (said && !said.startsWith('trace_reply.')) return said;
  } catch { /* i18n not ready: the English line */ }
  return 'That took more steps than one answer allows, and nothing came back. Ask for less at once, such as one label or a narrower search.';
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
export async function callAI({ provider, apiKey, model, messages, systemPrompt, tools, onToolCall, onToolResult, onToolsUnsupported, baseUrl, relay = false, signal }) {
  // 'custom' is the legacy NoteTrace name for the same OpenAI-compatible
  // path that NutriTrace calls 'oai-compat'. Both are accepted.
  if (!relay && !apiKey && provider !== 'custom' && provider !== 'oai-compat') {
    throw new Error('No API key configured. Add one in Settings → Trace Assistant.');
  }
  // signal: an AbortSignal that stops the request (TraceApps/notetrace#35).
  const cb = { onToolCall, onToolResult, onToolsUnsupported, relay, signal };
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
      return _callOpenAIWithTools(apiKey || 'no-key', model, messages, systemPrompt, tools, cb, base);
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
async function _post(relay, url, headers, body, signal) {
  if (!relay) {
    const res = await fetchProvider(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
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
  const res = await fetch(apiUrl('/api/ai/relay'), { method: 'POST', credentials: 'include', headers: h, body: JSON.stringify({ body }), signal });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) return { ok: false, status: 401, data: { error: { message: 'Not signed in. Sign in again to use Trace.' } } };
  return { ok: res.ok, status: res.status, data };
}

/** Server-proxy fallback for env-locked installs. Text-only — tools
 *  aren't relayed because the server can't execute client-side. */
export async function callAIProxy({ messages, systemPrompt, signal }) {
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
    body: JSON.stringify({ messages, systemPrompt }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('Not signed in — sign in again to use AI features.');
    throw _inLanguage(Object.assign(new Error(data.error || `AI proxy error ${res.status}`), { code: data.code }));
  }
  return data.text || data.content || data.message || (data.choices?.[0]?.message?.content) || '';
}

// ── Anthropic Claude (with tool use) ────────────────────────────────────────
// Rounds of tool calls in one answer. Going through many notes (search a
// page, read a batch, the next page...) needs more than a handful
// (TraceApps/notetrace#34); a model that loops forever still stops.
export const TOOL_ROUNDS = 12;
// Said to the model when the rounds run out: the answer comes from what it has.
export const OUT_OF_ROUNDS = "You can't call more tools for this request. Answer now from what you found. If you couldn't go through everything you needed to, say so plainly: what you covered and what's left, so the user can ask for the rest or narrow it down.";
// What the tool calls and their answers may add to the conversation, in
// bytes, before Trace wraps up early the same way: under the server relay's
// 1 MB, and in tokens about what a 128k-token model can hold, Japanese or
// Chinese included. A photo the user attached is already there and doesn't count.
export const HISTORY_MAX_BYTES = 300000;
const _bytes = (x) => new TextEncoder().encode(JSON.stringify(x)).length;
// The last request: out of rounds, or the tools have added as much as they should.
const _lastRound = (round, history, start) => round === TOOL_ROUNDS || (round > 0 && _bytes(history) - start > HISTORY_MAX_BYTES);
// Said for a tool call left unrun because one round's answers already passed
// HISTORY_MAX_BYTES: a model that asks for many at once can't pass it by much.
export const TOOL_SKIPPED = "Not run: this answer has already gathered as much as it can hold. Answer from what you have, and say what's left.";
const _room = (history, start) => ({ left: HISTORY_MAX_BYTES - (_bytes(history) - start) });
async function _runTool(name, args, room) {
  if (room.left <= 0) return { error: TOOL_SKIPPED };
  const result = await _executeTool(name, args);
  room.left -= _bytes(JSON.stringify(result)); // as it's sent: a JSON string inside the request
  return result;
}

async function _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, cb) {
  const { onToolCall, onToolResult } = cb || {};
  const claudeTools = (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
  let currentMessages = [...messages];
  const startBytes = _bytes(currentMessages);

  for (let round = 0; round <= TOOL_ROUNDS; round++) {
    const last = _lastRound(round, currentMessages, startBytes);
    const body = {
      model: model || AI_DEFAULT_MODELS.claude,
      max_tokens: REPLY_MAX_TOKENS,
      // Out of rounds: told to answer in the system prompt, so the
      // conversation itself stays in the order the provider expects.
      system: last ? `${systemPrompt}\n\n${OUT_OF_ROUNDS}` : systemPrompt,
      messages: currentMessages,
    };
    if (claudeTools.length) body.tools = claudeTools;
    // The tools stay declared (the history has tool calls in it), but can't be called.
    if (last && claudeTools.length) body.tool_choice = { type: 'none' };
    // A model that can't write that many is asked again as before (trace-reply.js).
    const res = await sendWithLengthFallback(body, (b) => _post(cb?.relay, 'https://api.anthropic.com/v1/messages', {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }, b, cb?.signal));
    const data = res.data;
    if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);
    const short = stoppedShort('claude', data);
    if (short) throw _stoppedShort(short);

    const toolUses = (data.content || []).filter(b => b.type === 'tool_use');
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    if (last) return _finalAnswer(textBlocks.map(b => b.text).join('\n'));
    if (toolUses.length === 0 || data.stop_reason !== 'tool_use') {
      return textBlocks.map(b => b.text).join('\n') || '';
    }
    // Measured before the model's own message: only what the tools answer
    // counts, so calls whose arguments are already sent (a recipe it wrote)
    // aren't skipped for nothing.
    const room = _room(currentMessages, startBytes);
    currentMessages.push({ role: 'assistant', content: data.content });
    const toolResults = [];
    for (const tu of toolUses) {
      if (onToolCall) onToolCall(tu.name, tu.input);
      const result = await _runTool(tu.name, tu.input, room);
      if (onToolResult) onToolResult(tu.name, result);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    currentMessages.push({ role: 'user', content: toolResults });
  }
  return _finalAnswer(''); // not reached: the last round always answers
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

  const startBytes = _bytes(currentMessages);

  for (let round = 0; round <= TOOL_ROUNDS; round++) {
    const last = _lastRound(round, currentMessages, startBytes);
    const selectedModel = model || AI_DEFAULT_MODELS.openai;
    const body = {
      model: selectedModel,
      // Out of rounds: told to answer in the system prompt (see Claude above).
      messages: last ? [{ role: 'system', content: `${systemPrompt}\n\n${OUT_OF_ROUNDS}` }, ...currentMessages.slice(1)] : currentMessages,
      ...getOpenAIChatParams({
        baseUrl,
        model: selectedModel,
        hasTools: openaiTools.length > 0,
        maxTokens: REPLY_MAX_TOKENS,
      }),
    };
    if (openaiTools.length) body.tools = openaiTools;
    if (last && openaiTools.length) body.tool_choice = 'none';
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (apiKey && apiKey !== 'no-key') headers['Authorization'] = `Bearer ${apiKey}`;
    // A server that won't take the longer reply is asked again as before.
    const send = (b) => sendWithLengthFallback(b, (x) => _post(cb?.relay, `${baseUrl}/v1/chat/completions`, headers, x, cb?.signal));
    // A model that can't use tools gets the request again without them.
    // Through the relay the server may already have done that (it says so
    // with trace_tools_unsupported).
    let sent = await sendWithToolFallback(body, send, { memory: toolSupport, baseUrl, model: selectedModel });
    // A server that refuses tool_choice "none" is asked once more without it.
    if (last && !sent.ok && (sent.status === 400 || sent.status === 422) && body.tool_choice) {
      delete body.tool_choice;
      sent = await sendWithToolFallback(body, send, { memory: toolSupport, baseUrl, model: selectedModel });
    }
    const { ok, status, data, toolsDropped, toolsRouted } = sent;
    if (!ok) throw new Error(data.error?.message || `AI API error ${status}`);
    if (toolsDropped || data.trace_tools_unsupported) onToolsUnsupported?.({ routed: toolsRouted || !!data.trace_tools_routed });
    // Cut off, a rewrite would be half a note and a tool call half its arguments.
    const short = stoppedShort('openai', data);
    if (short) throw _stoppedShort(short);

    const choice = data.choices[0];
    const msg = choice.message;
    // A server that ignores tool_choice may still ask for a tool on the last
    // round: its text, if any, is the answer.
    if (last) return _finalAnswer(msg.content);
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || '';
    }
    const room = _room(currentMessages, startBytes); // before the model's message (see Claude above)
    currentMessages.push(msg);
    for (const tc of msg.tool_calls) {
      if (onToolCall) onToolCall(tc.function.name, JSON.parse(tc.function.arguments || '{}'));
      const args = JSON.parse(tc.function.arguments || '{}');
      const result = await _runTool(tc.function.name, args, room);
      if (onToolResult) onToolResult(tc.function.name, result);
      currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return _finalAnswer(''); // not reached: the last round always answers
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
  const startBytes = _bytes(contents);

  for (let round = 0; round <= TOOL_ROUNDS; round++) {
    const last = _lastRound(round, contents, startBytes);
    const body = {
      // Out of rounds: told to answer in the system prompt (see Claude above).
      systemInstruction: { parts: [{ text: last ? `${systemPrompt}\n\n${OUT_OF_ROUNDS}` : systemPrompt }] },
      contents,
    };
    if (geminiTools) body.tools = geminiTools;
    if (last && geminiTools) body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    const res = await _post(cb?.relay, url, { 'Content-Type': 'application/json' }, body, cb?.signal);
    const data = res.data;
    if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);
    const short = stoppedShort('gemini', data);
    if (short) throw _stoppedShort(short);
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);
    const textParts = parts.filter(p => p.text);
    if (last) return _finalAnswer(textParts.map(p => p.text).join('\n'));
    if (functionCalls.length === 0) {
      return textParts.map(p => p.text).join('\n') || '';
    }
    const room = _room(contents, startBytes); // before the model's message (see Claude above)
    contents.push({ role: 'model', parts });
    const responseParts = [];
    for (const fc of functionCalls) {
      if (onToolCall) onToolCall(fc.functionCall.name, fc.functionCall.args || {});
      const result = await _runTool(fc.functionCall.name, fc.functionCall.args || {}, room);
      if (onToolResult) onToolResult(fc.functionCall.name, result);
      responseParts.push({ functionResponse: { name: fc.functionCall.name, response: geminiToolResponse(result) } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  return _finalAnswer(''); // not reached: the last round always answers
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
