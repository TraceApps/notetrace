/**
 * cooktrace-core.js: the pure parts of the CookTrace link (no database,
 * no network), so they can be unit tested.
 */

export const MAX_SEND_ITEMS = 50;

/** Trim, drop a trailing slash, require http(s). Returns '' when invalid. */
export function normalizeCooktraceUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/i.test(s)) return '';
  try { new URL(s); } catch { return ''; }
  return s;
}

/**
 * Checklist items to shopping list names: unchecked only, trimmed,
 * Markdown and [[link]] brackets stripped, de-duplicated (case-insensitive),
 * capped at MAX_SEND_ITEMS.
 */
export function shoppingNames(items, { includeChecked = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    if (!it || (it.checked && !includeChecked)) continue;
    const name = String(it.text ?? it.name ?? '')
      .replace(/\[\[([^[\]]+)\]\]/g, '$1')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= MAX_SEND_ITEMS) break;
  }
  return out;
}
