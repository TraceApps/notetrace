/**
 * note-images.js: add images to notes.
 *
 * Large photos are scaled down in the browser before upload (longest side
 * 2400px, JPEG), so a 12 MP phone photo becomes a few hundred KB and syncs
 * quickly. Small images, PNG screenshots, and GIFs are uploaded as they
 * are. The upload goes through NoteApi.uploadImage, so it lands on the
 * server, or on the device in Android local mode (and is uploaded by the
 * next sync once connected).
 */
import { NoteApi } from './api.js';

const MAX_DIM = 2400;
const MAX_BYTES = 1.5 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

export function isImageFile(file) {
  return !!file && typeof file.type === 'string' && file.type.startsWith('image/');
}

function _uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/** Scale a photo down when it's larger than needed. Resolves { blob, width, height, mime }. */
export async function prepareImage(file) {
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Formats the browser can't decode (HEIC on most browsers) go up as-is.
    return { blob: file, width: null, height: null, mime: file.type };
  }
  const { width, height } = bitmap;
  const keep = file.type === 'image/gif' ||
    (Math.max(width, height) <= MAX_DIM && (file.size <= MAX_BYTES || file.type === 'image/png'));
  if (keep) {
    bitmap.close?.();
    return { blob: file, width, height, mime: file.type };
  }
  const scale = Math.min(1, MAX_DIM / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency; paint white behind PNGs being converted.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
  return blob ? { blob, width: w, height: h, mime: 'image/jpeg' } : { blob: file, width, height, mime: file.type };
}

/**
 * Upload image files. Resolves attachment records ready for
 * NoteApi.addAttachments / createNote({ attachments }). Files that fail
 * are skipped and counted in `failed`. When the server's upload rate limit
 * is hit, it stops and returns `rateLimited` with the files not yet sent.
 */
export async function uploadNoteImages(files, { upload = (f) => NoteApi.uploadImage(f) } = {}) {
  const attachments = [];
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!isImageFile(file)) { failed++; continue; }
    try {
      const { blob, width, height, mime } = await prepareImage(file);
      const ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'img').replace(/[^a-z0-9]/gi, '');
      const base = String(file.name || 'image').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'image';
      const uploadFile = blob instanceof File ? blob : new File([blob], `${base}.${ext}`, { type: mime });
      const url = await upload(uploadFile);
      if (!url) { failed++; continue; }
      attachments.push({ uuid: _uuid(), url, mime, width, height });
    } catch (e) {
      // The server's upload rate limit: stop here and hand back what's left.
      if (/429|too many requests/i.test(String(e?.message || ''))) {
        return { attachments, failed, rateLimited: true, remaining: files.slice(i) };
      }
      failed++;
    }
  }
  return { attachments, failed, rateLimited: false, remaining: [] };
}
