/**
 * pdf.js: PDFs on notes, read in the app with PDF.js. Loaded the first time a
 * PDF is involved, so nobody pays for it otherwise.
 *
 *   pdfThumbnail(blob): a picture of the first page, for the file's chip
 *   pdfText(blob):      the text on its pages, for search
 *   openPdf(blob):      a document the viewer renders page by page
 *
 * PDFs aren't trusted: scripting and eval stay off, and fonts are drawn from
 * the file's own outlines rather than installed on the page.
 */
import { EXTRACTED_TEXT_MAX_CHARS } from './file-kinds.js';

let _lib = null;
async function lib() {
  if (!_lib) {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist/build/pdf.min.mjs'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    _lib = pdfjs;
  }
  return _lib;
}

async function _bytes(src) {
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (src instanceof Uint8Array) return src;
  return new Uint8Array(await src.arrayBuffer());
}

/** Let a document go, and the worker's copy of it. */
export function closePdf(doc) {
  try {
    if (doc?.loadingTask?.destroy) doc.loadingTask.destroy();
    else doc?.destroy?.();
  } catch { /* already closed */ }
}

/** Open a PDF from a Blob, File, or bytes. closePdf() it when done. */
export async function openPdf(src) {
  const pdfjs = await lib();
  // Fonts, character maps, decoders, and colour profiles ship with the app (vite.config.js).
  const base = new URL('pdfjs/', document.baseURI).href;
  return pdfjs.getDocument({
    data: await _bytes(src),
    isEvalSupported: false,
    enableScripting: false,
    disableFontFace: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
  }).promise;
}

/** Draw one page into a canvas at `cssWidth` CSS pixels wide, sharp on high-density screens. */
export async function renderPage(doc, pageNumber, canvas, cssWidth) {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const scale = (cssWidth / base.width) * dpr;
  const viewport = page.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
  await task.promise;
  page.cleanup();
  return { width: base.width, height: base.height };
}

/** A JPEG of the first page, `width` pixels wide: { blob, width, height, pages }. */
export async function pdfThumbnail(src, width = 480) {
  const doc = await openPdf(src);
  try {
    const canvas = document.createElement('canvas');
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    // A white sheet behind the page, as paper, whatever the theme.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob ? { blob, width: canvas.width, height: canvas.height, pages: doc.numPages } : null;
  } finally {
    closePdf(doc);
  }
}

/** The text on the first `maxPages` pages, lines kept, capped for search. */
export async function pdfText(src, { maxPages = 40, maxChars = EXTRACTED_TEXT_MAX_CHARS } = {}) {
  const doc = await openPdf(src);
  try {
    const out = [];
    let length = 0;
    for (let n = 1; n <= Math.min(doc.numPages, maxPages) && length < maxChars; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let line = '';
      const lines = [];
      for (const item of content.items) {
        line += item.str || '';
        if (item.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      const text = lines.map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
      if (text) { out.push(text); length += text.length; }
      page.cleanup();
    }
    return out.join('\n\n').slice(0, maxChars);
  } finally {
    closePdf(doc);
  }
}
