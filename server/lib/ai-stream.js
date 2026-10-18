// Kept identical in src/lib and server/lib. Custom providers speak OpenAI
// SSE; NoteTrace's relay uses trace-text / trace-result events so errors and
// tool-fallback metadata can still be delivered after HTTP headers are sent.
const MAX_EVENT = 2 * 1024 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;

function incomplete() {
  return new Error('The AI response stream ended before completion. Please retry; no incomplete changes were applied.');
}

async function readEvents(response, receive, activity) {
  if (!response.body?.getReader) throw incomplete();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', event = '', data = [], size = 0;
  const line = (text) => {
    if (!text) {
      const payload = data.join('\n');
      const type = event || 'message';
      event = ''; data = []; size = 0;
      return payload ? receive(type, payload) : false;
    }
    if (text.startsWith(':')) return false;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') {
      size += value.length;
      if (size > MAX_EVENT) throw new Error('The AI stream event is too large.');
      data.push(value);
    }
    return false;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // A final CR is a valid line terminator even without a following LF.
        if (pending.endsWith('\r')) line(pending.slice(0, -1));
        break;
      }
      activity?.();
      pending += decoder.decode(value, { stream: true });
      // Leave a trailing CR until the next chunk, in case CRLF was split.
      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        if (pending[i] !== '\r' && pending[i] !== '\n') continue;
        if (pending[i] === '\r' && i === pending.length - 1) break;
        const end = i;
        if (pending[i] === '\r' && pending[i + 1] === '\n') i++;
        if (line(pending.slice(start, end))) return;
        start = i + 1;
      }
      pending = pending.slice(start);
      if (pending.length > MAX_EVENT) throw new Error('The AI stream event is too large.');
    }
    // A partial event at EOF is intentionally not dispatched (SSE spec).
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Consume a successful OpenAI stream or a normal JSON/error response. */
export async function readAIResponse(response, { onText, onActivity } = {}) {
  if (!response.ok || !response.headers?.get('content-type')?.includes('text/event-stream')) {
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`AI provider returned an unreadable response (${response.status}).`); }
    return { ok: response.ok, status: response.status, data };
  }
  let result, finish = null, content = '', reasoning = false, count = 0;
  const calls = new Map();
  await readEvents(response, (event, raw) => {
    if (raw === '[DONE]') {
      if (finish == null) throw incomplete();
      return true;
    }
    let chunk;
    try { chunk = JSON.parse(raw); }
    catch { throw new Error('The AI provider sent an invalid stream event.'); }
    count += raw.length;
    if (count > MAX_RESPONSE) throw new Error('The AI response is too large.');
    if (event === 'trace-result') {
      if (typeof chunk?.ok !== 'boolean' || !Number.isInteger(chunk.status) || !chunk.data) throw incomplete();
      result = chunk;
      return true;
    }
    if (event === 'trace-text') {
      if (typeof chunk.text === 'string') onText?.(chunk.text);
      return false;
    }
    if (chunk.error || event === 'error') {
      const error = chunk.error || chunk;
      throw Object.assign(new Error(error.message || String(error)), { code: error.code });
    }
    const choice = chunk.choices?.find(c => c.index === 0) ?? (chunk.choices?.length === 1 && chunk.choices[0].index == null ? chunk.choices[0] : null);
    if (!choice) return false; // usage-only chunk or another choice
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') {
      content += delta.content;
      onText?.(delta.content);
    }
    // Keep only the presence of reasoning for the existing reasoning-only
    // error. Private reasoning is never forwarded or shown in the UI.
    reasoning ||= !!(delta.reasoning_content || delta.reasoning);
    for (const part of delta.tool_calls || []) {
      if (!Number.isInteger(part.index) || part.index < 0 || part.index > 127) throw new Error('Invalid streamed tool-call index.');
      const call = calls.get(part.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (typeof part.id === 'string') call.id += part.id;
      if (part.type && part.type !== 'function') throw new Error('Unsupported streamed tool-call type.');
      if (typeof part.function?.name === 'string') call.function.name += part.function.name;
      if (typeof part.function?.arguments === 'string') call.function.arguments += part.function.arguments;
      calls.set(part.index, call);
    }
    if (choice.finish_reason != null) finish = choice.finish_reason;
    return false;
  }, onActivity);
  if (result) return result;
  if (finish == null) throw incomplete();
  if (!['stop', 'tool_calls', 'length'].includes(finish)) throw new Error(`The AI response stopped without completing (${finish}). Please retry.`);
  const message = { role: 'assistant', content: content || null };
  if (calls.size) message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (reasoning && !content && !calls.size) message.reasoning_content = true;
  return { ok: true, status: response.status, data: { choices: [{ index: 0, message, finish_reason: finish }] } };
}

/** The timeout measures inactivity, not total generation time. Every byte,
 * including a reasoning delta or an SSE heartbeat, starts the clock again. */
export async function fetchAIResponse(fetcher, url, init, { onText, signal, idleMs = 120_000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let timer;
  const activity = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException('The AI provider stopped sending data. Please retry.', 'TimeoutError')), idleMs);
  };
  activity();
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    activity();
    return await readAIResponse(response, { onText, onActivity: activity });
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
