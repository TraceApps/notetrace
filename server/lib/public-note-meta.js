/**
 * public-note-meta.js: the <head> tags for a public note link, so a chat
 * app or social site that fetches the link shows the note's title, a line
 * of its text, and its first picture. Crawlers don't run the app, so these
 * go into the HTML the server sends. Pure, so it's testable without a
 * database.
 */
import { plainExcerpt } from './note-excerpt.js';

const DESCRIPTION_CHARS = 200;

/** Escape for an HTML attribute value or text node. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A one-paragraph plain-text summary of the note for og:description. */
export function publicNoteDescription(note) {
  let text;
  if (note.kind === 'checklist') {
    text = (note.items || []).map(i => `${i.checked ? '☑' : '☐'} ${i.text}`).join(' ');
  } else {
    text = plainExcerpt(note.body_md, DESCRIPTION_CHARS * 2).replace(/\s*\n\s*/g, ' ');
  }
  text = text.trim();
  if (text.length > DESCRIPTION_CHARS) text = text.slice(0, DESCRIPTION_CHARS).replace(/\s+\S*$/, '') + '…';
  return text;
}

/** An absolute URL for an attachment, or null when it isn't one the server serves. */
function absoluteUrl(url, origin, basePath) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${origin}${basePath}${url}`;
  return null;
}

/**
 * The tags to put in <head>, as one string.
 *   note      what getPublicNote returned
 *   origin    scheme and host the link was opened on (no trailing slash)
 *   basePath  BASE_URL ('' at the root)
 *   pageUrl   the full public link
 */
export function publicNoteHead(note, { origin, basePath = '', pageUrl, untitled = 'Untitled note' }) {
  const title = (note.title || '').trim() || untitled;
  const description = publicNoteDescription(note);
  const picture = (note.attachments || []).find(a => /^image\//.test(a.mime || ''));
  const image = absoluteUrl(picture?.url, origin, basePath);
  const icon = `${origin}${basePath}/icons/icon-512.png`;
  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    // Unlisted: the link works for whoever has it, but search engines skip it,
    // and opening a link inside the note doesn't hand its token to that site.
    `<meta name="robots" content="noindex, nofollow" />`,
    `<meta name="referrer" content="no-referrer" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="NoteTrace" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
    `<meta property="og:image" content="${escapeHtml(image || icon)}" />`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
  ];
  if (description) {
    tags.push(
      `<meta name="description" content="${escapeHtml(description)}" />`,
      `<meta property="og:description" content="${escapeHtml(description)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    );
  }
  return tags.join('\n  ');
}

/**
 * The app's index.html as served at /n/<token>. The build links its scripts
 * and styles relative to the page (./assets/...), which from /n/ would point
 * at /n/assets/, so a <base> sends them back to the app's root.
 */
export function publicPageHtml(html, basePath = '') {
  return html.replace(/<head>/i, `<head>\n  <base href="${escapeHtml(basePath)}/" />`);
}

/** The page with its <title> swapped for the note's tags. */
export function injectPublicNoteHead(html, head) {
  const swapped = html.replace(/<title>[^<]*<\/title>/, '');
  return swapped.replace('</head>', `  ${head}\n</head>`);
}
