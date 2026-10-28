/**
 * banner-text.js: the color for text and icons on a page banner.
 *
 * A banner is the accent (65%) fading to its second color (55%) over the
 * page's glass surface, with a light sheen. White on it read at about 2:1 in
 * the light theme and on light accents in the dark one, below the 3:1 a large
 * title needs (TraceApps/notetrace#39). White stays wherever it reads well;
 * elsewhere the near-black the app uses on light accents takes over.
 * No imports, so it can be tested on its own.
 */
export const LIGHT = '#FFFFFF';
export const DARK = '#0A0B0F';
/**
 * White stays at this much contrast or more. A large title needs 3:1; the
 * banner measured in the browser reads up to about 0.9 below this estimate
 * (its blur and saturation, the gradient's lighter end), so 4 keeps it at 3
 * or better.
 */
export const KEEP_WHITE_AT = 4;

/** [r, g, b, a] from #rgb, #rrggbb or rgb()/rgba(), or null. */
export function parseColor(value) {
  const s = String(value || '').trim();
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) return [...m[1]].map(c => parseInt(c + c, 16)).concat(1);
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) return [...parts.slice(0, 3), Number.isFinite(parts[3]) ? parts[3] : 1];
  }
  return null;
}

const channel = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
/** WCAG relative luminance. */
export function luminance([r, g, b]) { return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); }
/** WCAG contrast ratio of two luminances. */
export function contrast(a, b) { return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }

const over = (top, alpha, under) => top.slice(0, 3).map((v, i) => v * alpha + under[i] * (1 - alpha));

/**
 * The banner's color, roughly: both ends of the accent gradient over the
 * glass surface (itself over the page), averaged, with the sheen on top.
 */
export function bannerColor(accent, accent2, glass, bg) {
  const a = parseColor(accent), b = parseColor(accent2) || a, g = parseColor(glass), page = parseColor(bg);
  if (!a || !page) return null;
  const surface = g ? over(g, g[3], page) : page.slice(0, 3);
  const start = over(a, 0.65, surface), end = over(b, 0.55, surface);
  return start.map((v, i) => (v + end[i]) / 2).map(v => v + (255 - v) * 0.07);
}

/** LIGHT or DARK for text on that banner. */
export function bannerTextColor(accent, accent2, glass, bg) {
  const color = bannerColor(accent, accent2, glass, bg);
  if (!color) return LIGHT;
  const L = luminance(color);
  const white = contrast(luminance([255, 255, 255]), L);
  if (white >= KEEP_WHITE_AT) return LIGHT;
  return contrast(luminance(parseColor(DARK)), L) > white ? DARK : LIGHT;
}
