/**
 * share-intent.js: turns content shared into NoteTrace into a new note.
 *
 * Android: the ShareIntent native plugin (MainActivity) delivers text,
 * links, and files of any kind from the system share sheet; files arrive in
 * the app cache and are read here as File objects. Installed PWA: the
 * manifest's share_target POSTs to /share-target, where the service worker
 * holds the files in Cache Storage and redirects to
 * /#/?share=1&title=&text=&url=&files=<id> (takeSharedFiles reads them back).
 * Both open a pre-filled editor, which sorts the files into pictures, voice
 * notes, and attachments. (The field is still called `images`.)
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
      files.push(new File([blob], img.name || img.path.split('/').pop(), { type: img.mime || blob.type || 'application/octet-stream' }));
    } catch (e) {
      console.warn('[share] could not read a shared file:', e?.message || e);
    }
  }
  return files;
}

/** Files a PWA share left in Cache Storage (public/sw-extras.js). Read once, then removed. */
export async function takeSharedFiles(id) {
  if (!id || typeof caches === 'undefined') return [];
  try {
    const cache = await caches.open('note-share');
    const keys = (await cache.keys()).filter(r => r.url.includes(`/__share/${id}/`));
    const files = [];
    for (const req of keys) {
      const res = await cache.match(req);
      if (res) {
        const blob = await res.blob();
        const name = decodeURIComponent(res.headers.get('X-File-Name') || 'file');
        files.push(new File([blob], name, { type: blob.type || res.headers.get('Content-Type') || 'application/octet-stream' }));
      }
      await cache.delete(req);
    }
    return files;
  } catch {
    return [];
  }
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
