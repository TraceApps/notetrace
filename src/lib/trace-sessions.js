import { writable } from 'svelte/store';
import { TRACE_ACTIONS, cleanTraceReply } from './trace-prompts.js';
import { settingPrefix, settingScope } from './setting-key.js';

const empty = () => ({ action: null, busy: false, result: '', error: '', failure: '', instruction: '', asking: false, askedBody: '' });

/** A note id is only unique within its server and account. */
export function traceNoteKey(noteId) {
  return noteId == null ? null : `${settingScope()}:${settingPrefix()}:${noteId}`;
}

/** Requests belong to notes, not to the popup that happens to display them. */
export function createTraceSessions({ onComplete = () => {} } = {}) {
  const sessions = new Map();
  function forNote(key) {
    if (sessions.has(key)) return sessions.get(key);
    let state = empty();
    let generation = 0;
    let viewers = 0;
    let controller = null;
    const store = writable(state);
    function patch(changes) { state = { ...state, ...changes }; store.set(state); }
    const session = {
      subscribe: store.subscribe,
      patch,
      peek: () => state,
      view() { viewers++; return () => { viewers--; }; },
      reset() { generation++; controller?.abort(); controller = null; state = empty(); store.set(state); },
      async run(kind, { noteId, title = '', body, instruction = state.instruction, request }) {
        if (state.busy || (kind === 'custom' && !instruction.trim())) return;
        const action = TRACE_ACTIONS[kind];
        if (!action) return;
        const current = ++generation;
        const mine = controller = new AbortController();
        patch({ action: kind, asking: false, busy: true, result: '', error: '', failure: '', instruction, askedBody: body });
        try {
          const result = cleanTraceReply(await request({ systemPrompt: action.system, prompt: action.prompt(title, body, instruction), signal: mine.signal }));
          if (current !== generation) return;
          patch({ result, failure: result ? '' : 'empty', busy: false });
        } catch (error) {
          if (current !== generation) return;
          patch({ error: error?.message || '', failure: 'failed', busy: false });
        }
        if (controller === mine) controller = null;
        if (current !== generation) return;
        try {
          await onComplete({ key, noteId, title, failure: state.failure,
            isViewing: () => viewers > 0, isCurrent: () => current === generation });
        } catch { /* delivery cannot change a generated result */ }
      },
    };
    sessions.set(key, session);
    return session;
  }
  return {
    forNote,
    hasWork(key) { return !!sessions.get(key)?.peek().action; },
    clear() {
      for (const session of sessions.values()) session.reset();
      sessions.clear();
    },
  };
}

export const traceSessions = createTraceSessions({
  onComplete: async event => {
    if (event.noteId == null || !event.isCurrent()) return;
    const { notifyTraceCompletion } = await import('./trace-notifications.js');
    if (event.isCurrent()) await notifyTraceCompletion(event);
  },
});
