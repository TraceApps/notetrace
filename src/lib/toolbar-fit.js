/** Number of icon actions that fit beside note context, Close and optional More. */
export function visibleToolbarCount(width, count) {
  const compact = width < 600;
  const slot = compact ? 46 : 38;
  const context = (compact ? 32 + 24 : 44 + 96) + slot + 18 + (width >= 1100 ? 136 : 0);
  const available = Math.max(0, width - context);
  if (count * slot <= available) return count;
  return Math.max(0, Math.min(count, Math.floor((available - slot) / slot)));
}
