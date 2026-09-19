/**
 * The decision part of upload-cleanup.js, with no db or fs imports so it can
 * be unit tested. Returns the file names to delete.
 */
export function orphanUploads(entries, referencedNames, now, minAgeMs) {
  return entries
    .filter(e => e && typeof e.name === 'string' && !e.name.startsWith('.'))
    .filter(e => now - e.mtimeMs >= minAgeMs)
    .filter(e => !referencedNames.has(e.name))
    .map(e => e.name);
}
