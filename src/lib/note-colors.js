/**
 * note-colors.js: the sixteen note colors plus default, shared by cards, the
 * editor, and the color picker. Background and border come from CSS
 * tokens (tokens.css) so both themes stay in one place; `dot` is the
 * saturated swatch used for label dots and picker previews.
 */
export const NOTE_COLORS = [
  { value: null,   key: 'default', dot: 'var(--text-3)' },
  { value: 'ember', key: 'ember',  dot: '#FF7B7B' },
  { value: 'clay',  key: 'clay',   dot: '#FF9A6E' },
  { value: 'amber', key: 'amber',  dot: '#FFC15C' },
  { value: 'sand',  key: 'sand',   dot: '#E8CF7A' },
  { value: 'lime',  key: 'lime',   dot: '#C4E37A' },
  { value: 'moss',  key: 'moss',   dot: '#7FD6A4' },
  { value: 'sage',  key: 'sage',   dot: '#AFC7A5' },
  { value: 'mint',  key: 'mint',   dot: '#6FDCCB' },
  { value: 'sky',   key: 'sky',    dot: '#7ED4FF' },
  { value: 'tide',  key: 'tide',   dot: '#7FA8FF' },
  { value: 'indigo', key: 'indigo', dot: '#9D9DFF' },
  { value: 'plum',  key: 'plum',   dot: '#C9A8FF' },
  { value: 'orchid', key: 'orchid', dot: '#EE9CF5' },
  { value: 'rose',  key: 'rose',   dot: '#FF8FB3' },
  { value: 'bark',  key: 'bark',   dot: '#D1A77E' },
  { value: 'slate', key: 'slate',  dot: '#AEB8C8' },
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
