import { FONT_PAIRINGS } from './font-pairings.js';
const inter = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const system = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
export const FONT_GROUPS = ['pairings', 'defaults', 'sans', 'serif', 'mono'];
export const FONT_THEMES = [
  { id: 'default', name: 'Original', group: 'defaults', body: inter, title: "'Newsreader', Georgia, serif" },
  { id: 'manrope', name: 'Manrope', group: 'sans', assetSlug: 'manrope', body: "'Manrope', " + inter },
  { id: 'nunito', name: 'Nunito Sans', group: 'sans', assetSlug: 'nunito-sans', body: "'Nunito Sans', " + inter },
  { id: 'lora', name: 'Lora', group: 'serif', assetSlug: 'lora', body: "'Lora', Georgia, serif" },
  { id: 'mono', name: 'Roboto Mono', group: 'mono', assetSlug: 'roboto-mono', body: "'Roboto Mono', ui-monospace, monospace" },
  { id: 'system', name: 'System', group: 'defaults', body: system },
  { id: 'inter', name: 'Inter', group: 'sans', body: inter },
  { id: 'newsreader', name: 'Newsreader', group: 'serif', body: "'Newsreader', Georgia, serif" },
  { id: 'dm-sans', name: 'DM Sans', group: 'sans', assetSlug: 'dm-sans', body: "'DM Sans', 'Inter', system-ui, sans-serif" },
  { id: 'jakarta', name: 'Plus Jakarta Sans', group: 'sans', assetSlug: 'jakarta', body: "'Plus Jakarta Sans', 'Inter', system-ui, sans-serif" },
  { id: 'outfit', name: 'Outfit', group: 'sans', assetSlug: 'outfit', body: "'Outfit', 'Inter', system-ui, sans-serif" },
  { id: 'work-sans', name: 'Work Sans', group: 'sans', assetSlug: 'work-sans', body: "'Work Sans', 'Inter', system-ui, sans-serif" },
  { id: 'source-sans', name: 'Source Sans 3', group: 'sans', assetSlug: 'source-sans', body: "'Source Sans 3', 'Inter', system-ui, sans-serif" },
  { id: 'roboto', name: 'Roboto', group: 'sans', assetSlug: 'roboto', body: "'Roboto', 'Inter', system-ui, sans-serif" },
  { id: 'open-sans', name: 'Open Sans', group: 'sans', assetSlug: 'open-sans', body: "'Open Sans', 'Inter', system-ui, sans-serif" },
  { id: 'montserrat', name: 'Montserrat', group: 'sans', assetSlug: 'montserrat', body: "'Montserrat', 'Inter', system-ui, sans-serif" },
  { id: 'raleway', name: 'Raleway', group: 'sans', assetSlug: 'raleway', body: "'Raleway', 'Inter', system-ui, sans-serif" },
  { id: 'rubik', name: 'Rubik', group: 'sans', assetSlug: 'rubik', body: "'Rubik', 'Inter', system-ui, sans-serif" },
  { id: 'lexend', name: 'Lexend', group: 'sans', assetSlug: 'lexend', body: "'Lexend', 'Inter', system-ui, sans-serif" },
  { id: 'figtree', name: 'Figtree', group: 'sans', assetSlug: 'figtree', body: "'Figtree', 'Inter', system-ui, sans-serif" },
  { id: 'merriweather', name: 'Merriweather', group: 'serif', assetSlug: 'merriweather', body: "'Merriweather', Georgia, serif" },
  { id: 'source-serif', name: 'Source Serif 4', group: 'serif', assetSlug: 'source-serif', body: "'Source Serif 4', Georgia, serif" },
  { id: 'literata', name: 'Literata', group: 'serif', assetSlug: 'literata', body: "'Literata', Georgia, serif" },
  { id: 'cormorant', name: 'Cormorant Garamond', group: 'serif', assetSlug: 'cormorant', body: "'Cormorant Garamond', Georgia, serif" },
  { id: 'bitter', name: 'Bitter', group: 'serif', assetSlug: 'bitter', body: "'Bitter', Georgia, serif" },
  { id: 'jetbrains', name: 'JetBrains Mono', group: 'mono', assetSlug: 'jetbrains', body: "'JetBrains Mono', ui-monospace, monospace" },
  { id: 'inconsolata', name: 'Inconsolata', group: 'mono', assetSlug: 'inconsolata', body: "'Inconsolata', ui-monospace, monospace" },
  { id: 'fira-code', name: 'Fira Code', group: 'mono', assetSlug: 'fira-code', body: "'Fira Code', ui-monospace, monospace" },
  ...FONT_PAIRINGS,
];

export function fontThemeFor(value) {
  return FONT_THEMES.find(theme => theme.id === value) || FONT_THEMES[0];
}

export function applyFontTheme(value, root = document.documentElement) {
  const theme = fontThemeFor(value);
  root.style.setProperty('--font-sans', theme.body);
  root.style.setProperty('--font-note-title', theme.title || theme.body);
  root.style.setProperty('--font-display', theme.display || theme.body);
  root.style.setProperty('--font-mono', theme.mono || 'ui-monospace, monospace');
  root.style.setProperty('--mono', theme.mono || 'ui-monospace, monospace');
}

export function themeFontFamilies(theme) {
  return [...new Set([theme.body, theme.title, theme.mono].filter(Boolean).map(stack => stack.match(/^['"]([^'"]+)['"]/)?.[1]).filter(Boolean))];
}

export function applyTextSize(value, root = document.documentElement) {
  const number = Number(value);
  const size = Number.isFinite(number) ? Math.max(12, Math.min(22, number)) : 15;
  root.style.setProperty('--text-scale', String(size / 15));
}
