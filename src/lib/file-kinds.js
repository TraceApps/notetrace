/**
 * file-kinds.js: what kind of thing an attachment is, and how to show it.
 * Pure (no stores), so the cards, the editor, the viewer, and the tests all
 * agree.
 *
 *   image  shown in the picture grid
 *   audio  a voice note
 *   file   anything else: a chip with its name and size, opened in the viewer
 */

export const isAudio = (a) => /^audio\//i.test(String(a?.mime || '')) || /\.(webm|ogg|m4a|mp3|wav|aac)$/i.test(String(a?.url || ''));
// Attachments from before files existed were all pictures, so no type means an image.
export const isImage = (a) => !isAudio(a) && (/^image\//i.test(String(a?.mime || '')) || !a?.mime);
export const isFile = (a) => !!a && !isAudio(a) && !isImage(a);

/** The extension, lower case and without the dot, from the name or else the stored file. */
export function extOf(a) {
  const from = (s) => { const m = String(s || '').split('?')[0].match(/\.([A-Za-z0-9]{1,8})$/); return m ? m[1].toLowerCase() : ''; };
  return from(a?.name) || from(a?.url);
}

const TYPES = [
  // [test, label, icon, preview]
  [(m, e) => m === 'application/pdf' || e === 'pdf', 'PDF', 'picture_as_pdf', 'pdf'],
  [(m, e) => /^video\//.test(m) || ['mp4', 'm4v', 'mov', 'webm', 'ogv'].includes(e), 'Video', 'movie', 'video'],
  [(m, e) => ['doc', 'docx', 'odt', 'rtf', 'pages'].includes(e) || /wordprocessingml|msword|opendocument\.text/.test(m), 'Document', 'description', 'none'],
  [(m, e) => ['xls', 'xlsx', 'ods', 'numbers'].includes(e) || /spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(m), 'Spreadsheet', 'table_chart', 'none'],
  [(m, e) => ['ppt', 'pptx', 'odp', 'key'].includes(e) || /presentationml|ms-powerpoint|opendocument\.presentation/.test(m), 'Presentation', 'slideshow', 'none'],
  [(m, e) => e === 'csv' || e === 'tsv' || m === 'text/csv', 'Spreadsheet', 'table_chart', 'text'],
  [(m, e) => ['md', 'markdown'].includes(e) || m === 'text/markdown', 'Markdown', 'article', 'text'],
  [(m, e) => e === 'json' || m === 'application/json', 'JSON', 'data_object', 'text'],
  [(m, e) => ['txt', 'log', 'tex'].includes(e) || /^text\/plain/.test(m), 'Text', 'text_snippet', 'text'],
  [(m, e) => ['zip', '7z', 'rar', 'gz', 'tgz', 'tar', 'bz2', 'xz'].includes(e) || /zip|compressed|x-tar|gzip/.test(m), 'Archive', 'folder_zip', 'none'],
  [(m, e) => ['epub', 'mobi', 'azw3'].includes(e), 'Book', 'menu_book', 'none'],
  [(m, e) => e === 'ics' || m === 'text/calendar', 'Calendar', 'event', 'text'],
  [(m, e) => e === 'vcf' || m === 'text/vcard', 'Contact', 'contact_page', 'text'],
  [(m, e) => ['gpx', 'kml', 'kmz'].includes(e), 'Map', 'map', 'none'],
  [(m, e) => /^audio\//.test(m), 'Audio', 'music_note', 'none'],
  [(m, e) => /^image\//.test(m), 'Image', 'image', 'none'],
];

function _type(a) {
  const m = String(a?.mime || '').toLowerCase().split(';')[0];
  const e = extOf(a);
  return TYPES.find(([test]) => test(m, e)) || null;
}

/** A short name for the kind of file: "PDF", "Spreadsheet", or its extension. */
export function fileTypeLabel(a) {
  const t = _type(a);
  if (t) return t[1];
  const e = extOf(a);
  return e && e !== 'bin' ? e.toUpperCase() : 'File';
}

/** A Material Symbols icon for the file. */
export const fileIcon = (a) => _type(a)?.[2] || 'draft';

/** How the viewer can show it: 'pdf', 'text', 'video', or 'none' (download only). */
export const previewKind = (a) => _type(a)?.[3] || 'none';

/** "2.4 MB", "830 KB", "12 bytes". */
export function formatBytes(n) {
  if (n == null || n === '') return '';
  const b = Number(n);
  if (!Number.isFinite(b) || b < 0) return '';
  if (b < 1024) return `${b} ${b === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** The name to show and save a file under. */
export function displayName(a) {
  const n = String(a?.name || '').trim();
  if (n) return n;
  const file = String(a?.url || '').split('?')[0].split('/').pop();
  return file || 'File';
}

/** Text files worth reading into search, and how much of them. */
export const TEXT_INDEX_MAX_BYTES = 2 * 1024 * 1024;
export const EXTRACTED_TEXT_MAX_CHARS = 50000;
