/**
 * link-preview-core.js: the pure parts of link previews (no network, no
 * database), shared by the server and the client, and unit tested.
 */

const URL_RE = /\bhttps?:\/\/[^\s<>()"'`\]]+/gi;

/** The first http(s) link in a piece of text, trailing punctuation removed. */
export function firstUrl(text) {
  const m = String(text || '').match(URL_RE);
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?*_~]+$/, '');
  try { return new URL(url).href; } catch { return null; }
}

/** The first link in a note: title, then text, then checklist items. */
export function firstNoteUrl(note) {
  if (!note) return null;
  return firstUrl(note.title) || firstUrl(note.body_md)
    || (note.items || []).map(i => firstUrl(i.text)).find(Boolean) || null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function _attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return out;
}

function _abs(href, base) {
  if (!href) return null;
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}

const clean = (s, max) => {
  const t = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** Title, description, image, site name, and icon from a page's <head>. */
export function parseLinkPreview(html, pageUrl) {
  const head = String(html || '').slice(0, 300_000);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = _attrs(m[0]);
    const key = (a.property || a.name || '').toLowerCase();
    if (key && a.content != null && !(key in meta)) meta[key] = a.content;
  }
  let icon = null;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = _attrs(m[0]);
    const rel = (a.rel || '').toLowerCase();
    if (/(^|\s)(icon|apple-touch-icon)(\s|$)/.test(rel) && a.href) {
      const href = _abs(a.href, pageUrl);
      if (href && (!icon || rel.includes('apple-touch-icon'))) icon = href;
    }
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
  return {
    title: clean(meta['og:title'] || meta['twitter:title'] || titleTag, 200),
    description: clean(meta['og:description'] || meta['twitter:description'] || meta.description, 300),
    image: _abs(meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'], pageUrl),
    site: clean(meta['og:site_name'], 80) || host || null,
    icon: icon || (host ? _abs('/favicon.ico', pageUrl) : null),
  };
}
