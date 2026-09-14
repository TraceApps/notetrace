/**
 * import-export/index.js: import notes from Google Keep (Takeout), Evernote,
 * Blinko, or Markdown files, and export every note as a Markdown ZIP.
 *
 * Files are read in the browser / WebView (JSZip), parsed by the pure
 * modules next to this one, and handed to NoteApi.importNotes in
 * batches, so the same code works on the web, on Android with a server,
 * and on Android in local mode. Images are uploaded only for notes the
 * import actually created, so importing the same file twice doesn't
 * upload anything twice.
 */
import { NoteApi } from '../api.js';
import { isNative, getServerUrl, resolveAssetUrl } from '../platform.js';
import { uploadNoteImages } from '../note-images.js';
import { parseKeepNote } from './keep.js';
import { parseBlinkoBackup, isBlinkoBackup } from './blinko.js';
import { parseEnex, notebookFromFileName } from './evernote.js';
import { base64ToBytes } from './md5.js';
import { parseMarkdownNote, noteToMarkdown, exportFileName } from './markdown.js';

const BATCH = 200;
const MD_RE = /\.(md|markdown|txt)$/i;
const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif' };
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/heic': 'heic', 'image/avif': 'avif' };

async function _jszip() {
  const mod = await import('jszip');
  return mod.default || mod;
}

// Skip OS metadata that rides along in zips made on macOS or Windows.
const _junk = (path) => /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|\.obsidian|\.trash)(\/|$)/i.test(path);
const _isZip = (file) => /\.(zip|bko)$/i.test(file.name) || file.type === 'application/zip';

/**
 * Parse an import file without saving anything.
 *   source: 'keep' | 'markdown' | 'blinko' | 'evernote'
 *   options: { includeTrashed, tagsToLabels, username, labelNotebook }
 * Returns { notes, attachments, unreadable, trashedSkipped, readFile }.
 * readFile(ref) resolves an image a note refers to as a File, or null.
 */
export async function parseImportFile(file, source, options = {}) {
  const notes = [];
  let attachments = 0, unreadable = 0, trashedSkipped = 0;
  const zip = _isZip(file) ? await (await _jszip()).loadAsync(file) : null;
  const entries = zip ? Object.values(zip.files).filter(e => !e.dir && !_junk(e.name)) : [];
  const byPath = new Map(entries.map(e => [e.name, e]));
  const byName = new Map();
  for (const e of entries) {
    const base = e.name.split('/').pop().toLowerCase();
    if (!byName.has(base)) byName.set(base, e);
  }
  const texts = async (test) => zip
    ? Promise.all(entries.filter(e => test(e.name)).map(async e => ({ path: e.name, text: await e.async('string') })))
    : (test(file.name) ? [{ path: file.name, text: await file.text() }] : []);

  if (source === 'keep') {
    for (const { text } of await texts(p => /\.json$/i.test(p))) {
      let obj;
      try { obj = JSON.parse(text); } catch { unreadable++; continue; }
      const r = parseKeepNote(obj);
      if (!r) continue; // not a note (Takeout also holds other JSON)
      attachments += r.attachments;
      if (!r.note) continue;
      if (r.note.trashed && !options.includeTrashed) { trashedSkipped++; continue; }
      notes.push(r.note);
    }
  } else if (source === 'evernote') {
    const parseXml = (s, mime) => new DOMParser().parseFromString(s, mime);
    for (const { path, text } of await texts(p => /\.enex$/i.test(p))) {
      const r = parseEnex(text, { parseXml, notebook: notebookFromFileName(path), labelNotebook: options.labelNotebook !== false });
      notes.push(...r.notes);
      attachments += r.attachments;
      unreadable += r.unreadable;
    }
  } else if (source === 'blinko') {
    const [backup] = await texts(p => /(^|\/)bak\.json$/i.test(p));
    if (!backup) return { notes, attachments, unreadable, trashedSkipped, readFile: async () => null, notBlinko: true };
    let data;
    try { data = JSON.parse(backup.text); } catch { unreadable++; }
    if (data && isBlinkoBackup(data)) {
      const r = parseBlinkoBackup(data, { username: options.username, includeTrashed: options.includeTrashed });
      notes.push(...r.notes);
      attachments += r.attachments;
      trashedSkipped += r.trashedSkipped;
      if (r.accounts.length > 1 && !r.account) {
        return { notes, attachments, unreadable, trashedSkipped, readFile: async () => null, blinkoAccounts: r.accounts };
      }
    }
  } else {
    for (const { path, text } of await texts(p => MD_RE.test(p))) {
      try {
        const n = parseMarkdownNote(path, text, { tagsToLabels: options.tagsToLabels !== false });
        if (n) notes.push(n);
      } catch { unreadable++; }
    }
  }

  async function readFile(ref) {
    if (!ref) return null;
    // Evernote carries attachments inside the file as base64.
    if (ref.data) {
      try { return new File([base64ToBytes(ref.data)], ref.name || 'image', { type: ref.mime || 'image/jpeg' }); }
      catch { return null; }
    }
    if (!zip) return null;
    const entry = (ref.path && byPath.get(ref.path)) || byName.get(String(ref.name || ref.path || '').split('/').pop().toLowerCase());
    if (!entry) return null;
    const blob = await entry.async('blob');
    const name = entry.name.split('/').pop();
    const ext = (name.split('.').pop() || '').toLowerCase();
    return new File([blob], name, { type: MIME_BY_EXT[ext] || blob.type || 'application/octet-stream' });
  }
  return { notes, attachments, unreadable, trashedSkipped, readFile };
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The upload route allows 60 uploads a minute per client; a big Keep export
// with photos waits out the limit instead of dropping images.
async function _uploadWithRetry(files) {
  const out = { attachments: [], failed: 0 };
  let pending = files;
  for (let attempt = 0; pending.length; attempt++) {
    const r = await uploadNoteImages(pending, { upload: (f) => NoteApi.importUploadImage(f) });
    out.attachments.push(...r.attachments);
    out.failed += r.failed;
    if (!r.rateLimited) break;
    if (attempt >= 8) { out.failed += r.remaining.length; break; }
    pending = r.remaining;
    await _sleep(15000);
  }
  return out;
}

/**
 * Save parsed notes, then their images. onProgress({ done, total, phase }).
 * Returns { imported, skipped, labels_created, images, imagesMissing, imagesFailed }.
 */
export async function importParsedNotes(parsed, onProgress) {
  const { notes, readFile } = parsed;
  const total = { imported: 0, skipped: 0, labels_created: 0, images: 0, imagesMissing: 0, imagesFailed: 0 };
  const withImages = [];
  for (let i = 0; i < notes.length; i += BATCH) {
    const batch = notes.slice(i, i + BATCH);
    const r = await NoteApi.importNotes(batch.map(({ files, ...n }) => ({ ...n, files: files?.length ? files : undefined })));
    total.imported += r.imported || 0;
    total.skipped += r.skipped || 0;
    total.labels_created += r.labels_created || 0;
    (r.ids || []).forEach((id, j) => { if (id && batch[j].files?.length) withImages.push({ id, files: batch[j].files }); });
    onProgress?.({ done: Math.min(i + BATCH, notes.length), total: notes.length, phase: 'notes' });
  }

  const imageTotal = withImages.reduce((n, x) => n + x.files.length, 0);
  let imageDone = 0;
  for (const { id, files } of withImages) {
    const found = [];
    for (const ref of files) {
      const f = readFile ? await readFile(ref).catch(() => null) : null;
      if (f) found.push(f); else total.imagesMissing++;
    }
    if (found.length) {
      const up = await _uploadWithRetry(found);
      total.imagesFailed += up.failed;
      if (up.attachments.length) {
        try {
          await NoteApi.importAddAttachments(id, up.attachments);
          total.images += up.attachments.length;
        } catch { total.imagesFailed += up.attachments.length; }
      }
    }
    imageDone += files.length;
    onProgress?.({ done: imageDone, total: imageTotal, phase: 'images' });
  }

  // Server-side imports reach this device's local copy through sync.
  if (isNative && getServerUrl()) {
    try { const { fullSync } = await import('../sync.js'); await fullSync(true); } catch { /* next sync loop */ }
  }
  return total;
}

async function _fetchImage(url) {
  try {
    const res = await fetch(resolveAssetUrl(url));
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

/**
 * Every note (Notes and Archive, shared ones included) as a Markdown ZIP
 * blob, with images in NoteTrace/attachments/. onProgress(done, total).
 */
export async function buildMarkdownExport(onProgress) {
  const JSZip = await _jszip();
  const zip = new JSZip();
  const [active, archived, labels] = await Promise.all([
    NoteApi.getNotes({ view: 'notes' }),
    NoteApi.getNotes({ view: 'archive' }),
    NoteApi.getLabels(),
  ]);
  const labelName = new Map(labels.map(l => [l.id, l.name]));
  const used = { Notes: new Set(), Archive: new Set() };
  const all = [...active.map(n => ['Notes', n]), ...archived.map(n => ['Archive', n])];
  let count = 0, imagesMissing = 0;
  for (const [folder, note] of all) {
    const names = (note.labels || []).map(id => labelName.get(id)).filter(Boolean);
    const imagePaths = [];
    for (const a of note.attachments || []) {
      const blob = await _fetchImage(a.url);
      if (!blob) { imagesMissing++; continue; }
      const ext = EXT_BY_MIME[a.mime || blob.type] || (String(a.url).split('.').pop() || 'img').replace(/[^a-z0-9]/gi, '').slice(0, 5);
      const file = `${a.uuid}.${ext}`;
      zip.file(`NoteTrace/attachments/${file}`, blob);
      imagePaths.push(`../attachments/${file}`);
    }
    zip.file(`NoteTrace/${folder}/${exportFileName(note, used[folder])}`, noteToMarkdown(note, names, imagePaths));
    count++;
    onProgress?.(count, all.length);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { blob, count, imagesMissing };
}
