/**
 * link-preview.js: previews for the first link in a note, fetched by the
 * server (server/lib/link-preview.js). Needs a server, so there are none in
 * Android local mode. Results are kept for the session.
 */
import { NoteApi } from './api.js';
import { apiUrl, isNative, getServerUrl } from './platform.js';
export { firstNoteUrl } from '../../server/lib/link-preview-core.js';

export const linkPreviewsAvailable = !isNative || !!getServerUrl();

const _cache = new Map();

/** Resolves { url, title, description, site, image, icon } or null. */
export function getLinkPreview(url) {
  if (!linkPreviewsAvailable || !url) return Promise.resolve(null);
  if (!_cache.has(url)) {
    _cache.set(url, NoteApi.get(`/api/link-preview?url=${encodeURIComponent(url)}`)
      .then(p => (p && p.url ? p : null))
      .catch(() => { _cache.delete(url); return null; }));
  }
  return _cache.get(url);
}

export const previewImageUrl = (url) => apiUrl(`/api/link-preview/image?url=${encodeURIComponent(url)}`);
export const previewIconUrl = (url) => apiUrl(`/api/link-preview/icon?url=${encodeURIComponent(url)}`);
