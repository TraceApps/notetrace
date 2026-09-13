/**
 * import-export/index.js: import notes from Google Keep (Takeout) or
 * Markdown files, and export every note as a Markdown ZIP.
 *
 * Files are read in the browser / WebView (JSZip), parsed by the pure
 * modules next to this one, and handed to NoteApi.importNotes in
 * batches, so the same code works on the web, on Android with a server,
 * and on Android in local mode.
 */
import { NoteApi } from '../api.js';
import { isNative, getServerUrl } from '../platform.js';
import { parseKeepNote } from './keep.js';
import { parseMarkdownNote, noteToMarkdown, exportFileName } from './markdown.js';

const BATCH = 200;
const MD_RE = /\.(md|markdown|txt)$/i;

async function _loadZip(file) {
  const JSZipMod = await import('jszip');
  const JSZip = JSZipMod.default || JSZipMod;
  return JSZip.loadAsync(file);
}

// Skip OS metadata that rides along in zips made on macOS or Windows.
const _junk = (path) => /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|\.obsidian|\.trash)(\/|$)/i.test(path);

/** Entries of a zip (or a single file) matching `test`, as { path, text }. */
async function _entries(file, test) {
  if (!/\.zip$/i.test(file.name) && file.type !== 'application/zip') {
    return test(file.name) ? [{ path: file.name, text: await file.text() }] : [];
  }
  const zip = await _loadZip(file);
  const out = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || _junk(entry.name) || !test(entry.name)) continue;
    out.push({ path: entry.name, text: await entry.async('string') });
  }
  return out;
}

/**
 * Parse an import file without saving anything.
 *   source: 'keep' | 'markdown'
 *   options: { includeTrashed, tagsToLabels }
 * Returns { notes, attachments, unreadable, trashedSkipped }.
 */
export async function parseImportFile(file, source, options = {}) {
  const notes = [];
  let attachments = 0, unreadable = 0, trashedSkipped = 0;
  if (source === 'keep') {
    for (const { text } of await _entries(file, p => /\.json$/i.test(p))) {
      let obj;
      try { obj = JSON.parse(text); } catch { unreadable++; continue; }
      const r = parseKeepNote(obj);
      if (!r) continue; // not a note (Takeout also holds other JSON)
      attachments += r.attachments;
      if (!r.note) continue;
      if (r.note.trashed && !options.includeTrashed) { trashedSkipped++; continue; }
      notes.push(r.note);
    }
  } else {
    for (const { path, text } of await _entries(file, p => MD_RE.test(p))) {
      try {
        const n = parseMarkdownNote(path, text, { tagsToLabels: options.tagsToLabels !== false });
        if (n) notes.push(n);
      } catch { unreadable++; }
    }
  }
  return { notes, attachments, unreadable, trashedSkipped };
}

/**
 * Save parsed notes. onProgress(done, total) after each batch.
 * Returns { imported, skipped, labels_created }.
 */
export async function importParsedNotes(notes, onProgress) {
  const total = { imported: 0, skipped: 0, labels_created: 0 };
  for (let i = 0; i < notes.length; i += BATCH) {
    const r = await NoteApi.importNotes(notes.slice(i, i + BATCH));
    total.imported += r.imported || 0;
    total.skipped += r.skipped || 0;
    total.labels_created += r.labels_created || 0;
    onProgress?.(Math.min(i + BATCH, notes.length), notes.length);
  }
  // Server-side imports reach this device's local copy through sync.
  if (isNative && getServerUrl()) {
    try { const { fullSync } = await import('../sync.js'); await fullSync(true); } catch { /* next sync loop */ }
  }
  return total;
}

/** Every note (Notes and Archive, shared ones included) as a Markdown ZIP blob. */
export async function buildMarkdownExport() {
  const JSZipMod = await import('jszip');
  const JSZip = JSZipMod.default || JSZipMod;
  const zip = new JSZip();
  const [active, archived, labels] = await Promise.all([
    NoteApi.getNotes({ view: 'notes' }),
    NoteApi.getNotes({ view: 'archive' }),
    NoteApi.getLabels(),
  ]);
  const labelName = new Map(labels.map(l => [l.id, l.name]));
  const used = { Notes: new Set(), Archive: new Set() };
  let count = 0;
  for (const [folder, list] of [['Notes', active], ['Archive', archived]]) {
    for (const note of list) {
      const names = (note.labels || []).map(id => labelName.get(id)).filter(Boolean);
      zip.file(`NoteTrace/${folder}/${exportFileName(note, used[folder])}`, noteToMarkdown(note, names));
      count++;
    }
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { blob, count };
}
