// Kept identical in src/lib and server/lib. Context is an estimated text
// budget, not a request to resize the inference server's KV cache.
export const TOKEN_LIMIT_MAX = 1_048_576;
export const DEFAULT_TOKEN_LIMITS = { maxTokens: 16_384, contextSize: 0 };

const MESSAGES = {
  invalid: 'Use whole token counts: maximum output must be at least 1, and a context window must be larger than maximum output.',
  context: 'The estimated prompt leaves too little room for a response in your context window. Shorten the note or chat, or increase the context setting within your server’s capacity.',
  output: 'The model reached its output-token limit before completing the answer. Increase maximum output tokens in Settings → Trace, or reduce reasoning in your inference server.',
  reasoning: 'The model returned reasoning without a final answer. Increase maximum output tokens in Settings → Trace, or reduce reasoning in your inference server.',
  server: 'These token limits exceed the server administrator’s configured limits.',
};

export function tokenLimitError(code) {
  const error = new Error(MESSAGES[code]);
  error.code = `ai_tokens_${code}`;
  return error;
}

export function normalizeTokenLimits(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw tokenLimitError('invalid');
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_TOKEN_LIMITS)) {
    const raw = value[key];
    const n = raw === '' || raw == null ? fallback : Number(raw);
    if ((raw != null && typeof raw !== 'number' && typeof raw !== 'string') || !Number.isSafeInteger(n) || n < 0 || n > TOKEN_LIMIT_MAX) throw tokenLimitError('invalid');
    out[key] = n;
  }
  if (!out.maxTokens || (out.contextSize && out.contextSize <= out.maxTokens)) throw tokenLimitError('invalid');
  return out;
}

// Three UTF-8 bytes per token plus message overhead is only an estimate.
// Multimodal token counts depend on the model; leave those to the provider.
export function estimatePromptTokens(body) {
  if ((body.messages || []).some(m => Array.isArray(m.content) && m.content.some(p => p.type !== 'text'))) return null;
  const bytes = new TextEncoder().encode(JSON.stringify({ messages: body.messages || [], ...(body.tools ? { tools: body.tools } : {}) })).length;
  return Math.ceil(bytes / 3) + (body.messages || []).length * 16;
}

export function applyTokenLimits(body, value) {
  const limits = normalizeTokenLimits(value);
  let max = limits.maxTokens;
  if (limits.contextSize) {
    const input = estimatePromptTokens(body);
    if (input != null) {
      max = Math.min(max, limits.contextSize - input);
      if (max < 1) throw tokenLimitError('context');
    }
  }
  const out = { ...body, max_tokens: max };
  delete out.max_completion_tokens;
  return out;
}

export function serverTokenLimits(value, config = {}) {
  const limits = normalizeTokenLimits(value);
  const ceiling = (key) => {
    if (config[key] == null || config[key] === '') return TOKEN_LIMIT_MAX;
    const n = Number(config[key]);
    if (!Number.isSafeInteger(n) || n < 1 || n > TOKEN_LIMIT_MAX) throw tokenLimitError('server');
    return n;
  };
  if (limits.maxTokens > ceiling('ai_max_tokens')) throw tokenLimitError('server');
  const context = ceiling('ai_context_size');
  if (config.ai_context_size && (!limits.contextSize || limits.contextSize > context)) {
    limits.contextSize = context;
    if (limits.maxTokens >= context) throw tokenLimitError('server');
  }
  return limits;
}

export function openAIAnswer(data) {
  const choice = data.choices?.[0];
  // Do not apply an incomplete rewrite or execute incomplete tool arguments.
  if (choice?.finish_reason === 'length') throw tokenLimitError('output');
  const msg = choice?.message || {};
  if (!msg.content && !msg.tool_calls?.length && (msg.reasoning_content || msg.reasoning)) throw tokenLimitError('reasoning');
  return msg;
}
