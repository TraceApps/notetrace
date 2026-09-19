/**
 * file-index.js: what the app learns from a file when it's added, whether in
 * the editor or by an import. A PDF gets a picture of its first page (for its
 * chip) and its text; a text file gets its text. The text goes on the
 * attachment's extracted_text, where search finds it, the same as a voice
 * note's transcript.
 *
 * Returns the attachment fields to save ({ preview_url?, extracted_text? }),
 * or an empty object when there's nothing to add.
 */
import { previewKind, TEXT_INDEX_MAX_BYTES, EXTRACTED_TEXT_MAX_CHARS } from './file-kinds.js';

/** Files larger than this aren't read for a picture or text (they still attach). */
export const PDF_INDEX_MAX_BYTES = 40 * 1024 * 1024;

export async function fileIndexPatch(att, file, { uploadImage }) {
  const kind = previewKind(att);
  const patch = {};
  if (kind === 'pdf' && file.size <= PDF_INDEX_MAX_BYTES) {
    const { pdfThumbnail, pdfText } = await import('./pdf.js');
    const thumb = await pdfThumbnail(file).catch(() => null);
    if (thumb?.blob && uploadImage) {
      const stem = String(file.name || 'document').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'document';
      const url = await uploadImage(new File([thumb.blob], `${stem}-page1.jpg`, { type: 'image/jpeg' })).catch(() => null);
      if (url) patch.preview_url = url;
    }
    const text = await pdfText(file).catch(() => '');
    if (text.trim()) patch.extracted_text = text;
  } else if (kind === 'text' && file.size <= TEXT_INDEX_MAX_BYTES) {
    const text = (await file.text().catch(() => '')).slice(0, EXTRACTED_TEXT_MAX_CHARS);
    if (text.trim()) patch.extracted_text = text;
  }
  return patch;
}
