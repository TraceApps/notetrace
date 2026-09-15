/**
 * link-preview.js: fetch and cache link previews for note cards.
 *
 * The server fetches the page (never the browser or phone, so reading a
 * note doesn't tell a site who you are), through the SSRF guard, with a
 * short timeout and a size cap, and keeps the result for a week (a failure
 * for a day). Preview images and icons are passed through the same guard,
 * and only for addresses that came from a cached preview, so this can't be
 * used as an open proxy.
 *
 * Links to private or loopback addresses get no preview unless
 * ALLOW_PRIVATE_LINK_PREVIEWS=1.
 */
import db from '../db.js';
import { assertSafeUrl } from './ssrf-guard.js';
import { parseLinkPreview } from './link-preview-core.js';

const OK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_MAX_BYTES = 1_000_000;
const IMAGE_MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (compatible; NoteTrace link preview)';

const allowPrivate = () => /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_PRIVATE_LINK_PREVIEWS || ''));
const guard = (url) => assertSafeUrl(url, { allowPrivate: allowPrivate(), allowPrivateEnvHint: 'ALLOW_PRIVATE_LINK_PREVIEWS' });

/** fetch() that re-checks every redirect hop against the SSRF guard. */
async function _guardedFetch(url, accept) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    await guard(current);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA, Accept: accept },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error('Too many redirects');
}

async function _readCapped(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size >= max) { reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

const _inflight = new Map();

/** The preview for a URL: { url, title, description, site, image, icon } or null. */
export async function getLinkPreview(url) {
  let normalized;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    normalized = u.href;
  } catch { return null; }

  const row = db.prepare('SELECT * FROM link_previews WHERE url = ?').get(normalized);
  if (row) {
    const age = Date.now() - Date.parse(row.fetched_at + 'Z');
    if (age < (row.ok ? OK_TTL_MS : FAIL_TTL_MS)) return row.ok ? _shape(row) : null;
  }
  if (_inflight.has(normalized)) return _inflight.get(normalized);
  const job = _fetchPreview(normalized).finally(() => _inflight.delete(normalized));
  _inflight.set(normalized, job);
  return job;
}

async function _fetchPreview(url) {
  let data = null;
  try {
    const { res, finalUrl } = await _guardedFetch(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
    const type = res.headers.get('content-type') || '';
    if (res.ok && /html|xml/i.test(type)) {
      const html = (await _readCapped(res, PAGE_MAX_BYTES)).toString('utf8');
      const p = parseLinkPreview(html, finalUrl);
      if (p.title || p.description || p.image) data = p;
    } else if (res.ok && /^image\//i.test(type)) {
      res.body?.cancel?.().catch(() => {});
      let host = '';
      try { host = new URL(finalUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
      data = { title: null, description: null, image: finalUrl, site: host, icon: null };
    } else {
      res.body?.cancel?.().catch(() => {});
    }
  } catch { /* unreachable, blocked, or not a page: cache the miss */ }
  db.prepare(`INSERT INTO link_previews (url, ok, title, description, site, image_url, icon_url, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(url) DO UPDATE SET ok = excluded.ok, title = excluded.title, description = excluded.description,
      site = excluded.site, image_url = excluded.image_url, icon_url = excluded.icon_url, fetched_at = excluded.fetched_at`)
    .run(url, data ? 1 : 0, data?.title || null, data?.description || null, data?.site || null, data?.image || null, data?.icon || null);
  return data ? _shape({ url, title: data.title, description: data.description, site: data.site, image_url: data.image, icon_url: data.icon }) : null;
}

function _shape(row) {
  return { url: row.url, title: row.title, description: row.description, site: row.site, image: !!row.image_url, icon: !!row.icon_url };
}

/**
 * The preview image or icon for a previewed page. Only addresses stored
 * with a preview are fetched. Resolves { type, body } or null.
 */
export async function getPreviewAsset(pageUrl, kind) {
  let normalized;
  try { const u = new URL(pageUrl); u.hash = ''; normalized = u.href; } catch { return null; }
  const row = db.prepare('SELECT image_url, icon_url FROM link_previews WHERE url = ? AND ok = 1').get(normalized);
  const target = kind === 'icon' ? row?.icon_url : row?.image_url;
  if (!target) return null;
  try {
    const { res } = await _guardedFetch(target, 'image/*');
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/^image\/(png|jpe?g|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)/i.test(type)) {
      res.body?.cancel?.().catch(() => {});
      return null;
    }
    const body = await _readCapped(res, IMAGE_MAX_BYTES);
    return { type: type.split(';')[0], body };
  } catch { return null; }
}
