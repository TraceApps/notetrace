/**
 * share-intent.js: turns content shared into NoteTrace into a new note.
 *
 * Android: the ShareIntent native plugin (MainActivity) delivers text and
 * links from the system share sheet. Installed PWA: the manifest's
 * share_target sends a GET to /share-target, which the server redirects to
 * /#/?share=1&title=&text=&url=. Both end up in `pendingShare`, which the
 * Notes screen watches to open a pre-filled editor.
 */
import { writable } from 'svelte/store';
import { registerPlugin } from '@capacitor/core';
import { isNative } from './platform.js';

export const pendingShare = writable(null);

/** Build note fields from shared title / text / url, avoiding a duplicated link. */
export function shareToNote({ title = '', text = '', url = '' } = {}) {
  const t = String(text || '').trim();
  const u = String(url || '').trim();
  let body = t;
  if (u && !t.includes(u)) body = t ? `${t}\n\n${u}` : u;
  return { title: String(title || '').trim().slice(0, 1000), body_md: body };
}

let _started = false;

export async function startShareIntake(goHome) {
  if (!isNative || _started) return;
  _started = true;
  const ShareIntent = registerPlugin('ShareIntent');
  const deliver = (share) => {
    if (!share) return;
    pendingShare.set(shareToNote(share));
    goHome?.();
  };
  try {
    await ShareIntent.addListener('shareReceived', deliver);
    const { share } = await ShareIntent.getPending();
    deliver(share);
  } catch (e) {
    console.warn('[share] intake unavailable:', e?.message || e);
  }
}
