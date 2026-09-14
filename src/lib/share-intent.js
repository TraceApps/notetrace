/**
 * share-intent.js: turns content shared into NoteTrace into a new note.
 *
 * Android: the ShareIntent native plugin (MainActivity) delivers text,
 * links, and images from the system share sheet; images arrive as files in
 * the app cache and are read here as File objects. Installed PWA: the
 * manifest's share_target sends a GET to /share-target, which the server
 * redirects to /#/?share=1&title=&text=&url= (text and links only). Both end
 * up in `pendingShare`, which the Notes screen watches to open a pre-filled
 * editor that uploads any images.
 */
import { writable } from 'svelte/store';
import { Capacitor, registerPlugin } from '@capacitor/core';
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

async function _sharedFiles(images = []) {
  const files = [];
  for (const img of images) {
    try {
      const res = await fetch(Capacitor.convertFileSrc(`file://${img.path}`));
      if (!res.ok) continue;
      const blob = await res.blob();
      files.push(new File([blob], img.name || img.path.split('/').pop(), { type: img.mime || blob.type }));
    } catch (e) {
      console.warn('[share] could not read shared image:', e?.message || e);
    }
  }
  return files;
}

let _started = false;

export async function startShareIntake(goHome) {
  if (!isNative || _started) return;
  _started = true;
  const ShareIntent = registerPlugin('ShareIntent');
  const take = async () => {
    const { share } = await ShareIntent.getPending();
    if (!share) return;
    const prefill = shareToNote(share);
    prefill.images = await _sharedFiles(share.images);
    if (!prefill.title && !prefill.body_md && !prefill.images.length) return;
    pendingShare.set(prefill);
    goHome?.();
  };
  try {
    await ShareIntent.addListener('shareReceived', () => { take().catch(() => {}); });
    await take();
  } catch (e) {
    console.warn('[share] intake unavailable:', e?.message || e);
  }
}
