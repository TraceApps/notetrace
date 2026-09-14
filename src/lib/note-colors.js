/**
 * note-colors.js: the six note colors plus default, shared by cards, the
 * editor, and the color picker. Background and border come from CSS
 * tokens (tokens.css) so both themes stay in one place; `dot` is the
 * saturated swatch used for label dots and picker previews.
 */
export const NOTE_COLORS = [
  { value: null,   key: 'default', dot: 'var(--text-3)' },
  { value: 'plum', key: 'plum',    dot: '#C9A8FF' },
  { value: 'tide', key: 'tide',    dot: '#7FA8FF' },
  { value: 'moss', key: 'moss',    dot: '#7FD6A4' },
  { value: 'sand', key: 'sand',    dot: '#E8CF7A' },
  { value: 'clay', key: 'clay',    dot: '#FF9A6E' },
  { value: 'rose', key: 'rose',    dot: '#FF8FB3' },
];

const BY_VALUE = new Map(NOTE_COLORS.map(c => [c.value, c]));

export function noteColorStyle(value) {
  const key = BY_VALUE.get(value || null)?.key || 'default';
  const glow = key === 'default' ? 'var(--accent)' : BY_VALUE.get(value).dot;
  return `--note-bg: var(--note-${key}-bg); --note-border: var(--note-${key}-border); --note-glow: ${glow};`;
}

export function colorDot(value) {
  return BY_VALUE.get(value || null)?.dot || 'var(--text-3)';
}
