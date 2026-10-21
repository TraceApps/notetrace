import { writable } from 'svelte/store';
import { settingPrefix, settingScope } from './setting-key.js';

export const traceChatOpen = writable(false);

// Keep request identity separate from the panel so closing it never cancels a
// reply. Account changes, clearing chat, and unmounting invalidate late replies.
export function createTraceChatRequests({ scope, onComplete = () => {} }) {
  const instance = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  let generation = 0;
  let serial = 0;
  const keys = new Set();
  return {
    begin(title = 'Trace') {
      const account = scope(), epoch = generation;
      const key = `${account}:chat:${instance}:${++serial}`;
      keys.add(key);
      let completed = false;
      const isCurrent = () => epoch === generation && account === scope();
      return {
        isCurrent,
        async complete(failure = '') {
          if (completed || !isCurrent()) return;
          completed = true;
          try { await onComplete({ kind: 'trace-chat', key, title, failure, isCurrent }); }
          catch { /* notification failures cannot change a reply */ }
        },
      };
    },
    isCurrent: key => keys.has(key) && key.startsWith(`${scope()}:chat:`),
    clear() { generation++; keys.clear(); traceChatOpen.set(false); },
  };
}

export const traceChatRequests = createTraceChatRequests({
  scope: () => `${settingScope()}:${settingPrefix()}`,
  onComplete: async event => {
    const { notifyTraceChatCompletion } = await import('./trace-notifications.js');
    if (event.isCurrent()) await notifyTraceChatCompletion(event);
  },
});
