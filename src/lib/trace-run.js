/**
 * trace-run.js: one-shot Trace requests outside the chat panel, for the
 * editor's Trace actions (Tidy Up, Expand, Summarize, Make a Checklist, and
 * your own instruction).
 *
 * Uses the same provider setup as the chat: the user's own key from
 * Settings, Trace, or the server's provider when AI is set by environment
 * variables (then the request goes through /api/ai/chat).
 */
import { derived, get } from 'svelte/store';
import { callAI, callAIProxy, AI_DEFAULT_MODELS } from './aiChat.js';
import { aiEffectivelyEnabled, aiKeyVerified, envLocks, aiProvider, aiApiKey, aiModel, aiBaseUrl, aiTokenLimits } from '../stores/settings.js';

/** True when Trace is on and has a working provider. */
export const traceReady = derived(
  [aiEffectivelyEnabled, aiKeyVerified, envLocks],
  ([$on, $verified, $locks]) => !!$on && (!!$locks.ai || !!$verified),
);

export async function askTrace({ systemPrompt, prompt }) {
  const messages = [{ role: 'user', content: prompt }];
  if (get(envLocks).ai) return callAIProxy({ messages, systemPrompt, tokenLimits: get(aiTokenLimits) });
  const provider = get(aiProvider);
  return callAI({
    provider,
    apiKey: get(aiApiKey),
    model: get(aiModel) || AI_DEFAULT_MODELS[provider] || '',
    baseUrl: get(aiBaseUrl),
    tokenLimits: get(aiTokenLimits),
    messages,
    systemPrompt,
    tools: [],
  });
}

export { TRACE_ACTIONS, cleanTraceReply, titleLine, checklistLines } from './trace-prompts.js';
