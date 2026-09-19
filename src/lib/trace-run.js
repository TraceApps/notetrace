/**
 * trace-run.js: one-shot Trace requests outside the chat panel, for the
 * editor's Trace actions (Tidy Up, Summarize, Make a Checklist).
 *
 * Uses the same provider setup as the chat: the user's own key from
 * Settings, Trace, or the server's provider when AI is set by environment
 * variables (then the request goes through /api/ai/chat).
 */
import { derived, get } from 'svelte/store';
import { callAI, callAIProxy, AI_DEFAULT_MODELS } from './aiChat.js';
import { aiEffectivelyEnabled, aiKeyVerified, envLocks, aiProvider, aiApiKey, aiModel, aiBaseUrl } from '../stores/settings.js';

/** True when Trace is on and has a working provider. */
export const traceReady = derived(
  [aiEffectivelyEnabled, aiKeyVerified, envLocks],
  ([$on, $verified, $locks]) => !!$on && (!!$locks.ai || !!$verified),
);

export async function askTrace({ systemPrompt, prompt }) {
  const messages = [{ role: 'user', content: prompt }];
  if (get(envLocks).ai) return callAIProxy({ messages, systemPrompt });
  const provider = get(aiProvider);
  return callAI({
    provider,
    apiKey: get(aiApiKey),
    model: get(aiModel) || AI_DEFAULT_MODELS[provider] || '',
    baseUrl: get(aiBaseUrl),
    messages,
    systemPrompt,
    tools: [],
  });
}

const RULES = 'Reply with only the result, no preamble, no explanation, no code fences.';

/** Prompts for the editor actions. Pure, so they're testable. */
export const TRACE_ACTIONS = {
  tidy: {
    system: `You tidy up notes. Fix spelling, grammar, and punctuation, and add light Markdown structure (short paragraphs, lists where the text is clearly a list, headings only for long notes). Keep the author's words, meaning, facts, tone, and language. Don't add information, and don't shorten. ${RULES}`,
    prompt: (title, body) => `${title ? `Title: ${title}\n\n` : ''}${body}`,
  },
  summarize: {
    system: `You summarize notes in the note's language: a few short bullet points (at most 5) with the key facts, decisions, dates, and to-dos. ${RULES} Use Markdown "- " bullets.`,
    prompt: (title, body) => `${title ? `Title: ${title}\n\n` : ''}${body}`,
  },
  // A spoken recording, summarised from its transcript. Separate from
  // `summarize` because speech rambles: the job is to compress, and to keep
  // the names, dates, and anything the speaker said they would do.
  recap: {
    system: `You summarize a spoken recording from its transcript, in the speaker's language: at most 5 short bullet points covering the key facts, decisions, names, dates, and anything to do. Always much shorter than the transcript. Don't invent anything that wasn't said. ${RULES} Use Markdown "- " bullets.`,
    prompt: (title, body) => `${title ? `Note title: ${title}\n\n` : ''}Transcript:\n${body}`,
  },
  title: {
    system: `You write a short title for a note: 2 to 6 words, in the note's language, no quotes and no ending period. ${RULES}`,
    prompt: (title, body) => body,
  },
  checklist: {
    system: `You turn a note into a checklist. Output one item per line, each a short actionable item, in the note's language and in a sensible order. No bullets, numbers, or checkboxes, and no headings. ${RULES}`,
    prompt: (title, body) => `${title ? `Title: ${title}\n\n` : ''}${body}`,
  },
};

/** Clean a model reply: drop code fences and a leading "Here is..." line some models add anyway. */
export function cleanTraceReply(text) {
  let s = String(text || '').trim();
  const fenced = s.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fenced) s = fenced[1].trim();
  s = s.replace(/^(here('| i)s|sure[,!]|okay[,!])[^\n]*:\s*\n+/i, '');
  return s.trim();
}

/** A title reply to a single clean line, or '' when there isn't one. */
export function titleLine(text) {
  const line = cleanTraceReply(text).split('\n').map(l => l.trim()).find(Boolean) || '';
  return line.replace(/^(title:\s*)/i, '').replace(/^["'“”‘’*#\s]+|["'“”‘’*\s.]+$/g, '').slice(0, 80);
}

/** Checklist reply to item texts: one per line, stray bullets and boxes removed. */
export function checklistLines(text) {
  return cleanTraceReply(text)
    .split('\n')
    .map(l => l.replace(/^\s*([-*+•]\s+)?(\[[ xX]\]\s+)?(\d+[.)]\s+)?/, '').trim())
    .filter(Boolean)
    .slice(0, 200);
}
