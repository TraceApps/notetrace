/**
 * note-print.js: a note as a printable page, and printing it. The system's
 * print dialog is also how a note becomes a PDF (Save as PDF), in a browser
 * and on Android alike.
 *
 * The page stands on its own: pictures are inlined as data, so it prints the
 * same offline, in Android local mode, and from a server that needs sign-in.
 * A browser prints it from a hidden frame; the Android WebView can't print,
 * so the NotePrint plugin hands it to Android's PrintManager.
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { NoteLink } from './note-link-extension.js';
import { isNative, resolveAssetUrl } from './platform.js';
import { isAudio, isImage, isFile, fileTypeLabel, formatBytes, displayName } from './file-kinds.js';
import { formatDuration } from './voice-recorder.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A note body's Markdown as HTML, through the same editor the app writes it with. */
export function markdownToHtml(md) {
  if (!String(md || '').trim()) return '';
  const editor = new Editor({
    extensions: [StarterKit.configure({ underline: false, heading: { levels: [1, 2, 3] } }), Markdown, NoteLink],
    content: md,
    contentType: 'markdown',
  });
  try { return editor.getHTML(); } finally { editor.destroy(); }
}

async function _dataUrl(url) {
  try {
    const res = await fetch(resolveAssetUrl(url), { credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onloadend = () => resolve(String(r.result || '') || null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const PRINT_CSS = `
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #1d1d1f; font: 11.5pt/1.55 -apple-system, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif; }
  h1.title { font: 600 22pt/1.2 Newsreader, Georgia, "Times New Roman", serif; margin: 0 0 6pt; }
  .meta { color: #6b6b72; font-size: 9.5pt; margin: 0 0 14pt; }
  .meta span + span::before { content: " \\00b7 "; }
  .body h1 { font-size: 16pt; margin: 14pt 0 6pt; }
  .body h2 { font-size: 14pt; margin: 12pt 0 5pt; }
  .body h3 { font-size: 12pt; margin: 10pt 0 4pt; }
  .body p { margin: 0 0 7pt; }
  .body ul, .body ol { margin: 0 0 8pt; padding-left: 18pt; }
  .body li p { margin: 0 0 2pt; }
  .body blockquote { margin: 0 0 8pt; padding-left: 10pt; border-left: 3px solid #d0d0d6; color: #4a4a50; }
  .body pre { background: #f4f4f6; padding: 8pt; border-radius: 6px; white-space: pre-wrap; font-size: 9.5pt; }
  .body code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9.5pt; }
  .body hr { border: 0; border-top: 1px solid #d0d0d6; margin: 12pt 0; }
  .body a { color: #3a5bd9; }
  .note-link { color: #3a5bd9; }
  ul.items { list-style: none; padding: 0; margin: 0 0 10pt; }
  ul.items li { display: flex; gap: 8pt; align-items: baseline; padding: 2.5pt 0; page-break-inside: avoid; }
  .box { font-size: 12pt; line-height: 1; }
  li.done .text { text-decoration: line-through; color: #8a8a90; }
  .due { color: #6b6b72; font-size: 9pt; margin-left: 4pt; }
  .pictures { display: flex; flex-wrap: wrap; gap: 8pt; margin: 4pt 0 12pt; }
  .pictures img { max-width: 100%; max-height: 120mm; border-radius: 4pt; page-break-inside: avoid; }
  .pictures.many img { max-width: calc(50% - 4pt); }
  h2.section { font-size: 10pt; text-transform: uppercase; letter-spacing: 0.06em; color: #6b6b72; margin: 14pt 0 6pt; }
  .voice { margin: 0 0 10pt; page-break-inside: avoid; }
  .voice .length { color: #6b6b72; font-size: 9.5pt; }
  .voice ul { margin: 4pt 0; padding-left: 16pt; }
  .voice .transcript { white-space: pre-wrap; color: #3a3a40; font-size: 10pt; margin: 4pt 0 0; }
  .files { margin: 0; padding-left: 16pt; }
  .files li { margin: 2pt 0; }
  .files .kind { color: #6b6b72; font-size: 9.5pt; }
`;

/** The note as a whole HTML document, ready to print. */
export async function noteToPrintHtml(note, { labels = [], t = (k) => k, locale } = {}) {
  const atts = note.attachments || [];
  const pictures = atts.filter(isImage);
  const voice = atts.filter(isAudio);
  const files = atts.filter(isFile);
  const imgs = (await Promise.all(pictures.map(a => _dataUrl(a.url)))).filter(Boolean);
  const edited = note.updated_at ? new Date(String(note.updated_at).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(note.updated_at) ? '' : 'Z')) : null;

  const meta = [
    ...labels.map(l => esc(l)),
    edited && !Number.isNaN(edited.getTime()) ? esc(t('print.edited', { values: { when: edited.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) } })) : '',
  ].filter(Boolean);

  let content = '';
  if (imgs.length) content += `<div class="pictures${imgs.length > 1 ? ' many' : ''}">${imgs.map(src => `<img src="${src}" alt="">`).join('')}</div>`;
  if (note.kind === 'checklist') {
    const items = note.items || [];
    const row = (i) => `<li class="${i.checked ? 'done' : ''}"><span class="box">${i.checked ? '&#9745;' : '&#9744;'}</span><span class="text">${esc(i.text)}${i.due_date ? `<span class="due">${esc(i.due_date)}</span>` : ''}</span></li>`;
    content += `<ul class="items">${items.filter(i => !i.checked).map(row).join('')}${items.filter(i => i.checked).map(row).join('')}</ul>`;
  } else {
    content += `<div class="body">${markdownToHtml(note.body_md)}</div>`;
  }
  if (voice.length) {
    content += `<h2 class="section">${esc(t('print.voice_notes'))}</h2>`;
    for (const v of voice) {
      const bullets = String(v.summary || '').split('\n').map(l => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
      content += `<div class="voice"><div class="length">${esc(t('print.recording'))}${v.duration_ms ? ` · ${esc(formatDuration(v.duration_ms))}` : ''}</div>`
        + (bullets.length ? `<ul>${bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : '')
        + (v.extracted_text ? `<p class="transcript">${esc(v.extracted_text)}</p>` : '')
        + '</div>';
    }
  }
  if (files.length) {
    content += `<h2 class="section">${esc(t('print.files'))}</h2><ul class="files">`
      + files.map(f => `<li>${esc(displayName(f))} <span class="kind">${esc(fileTypeLabel(f))}${f.size_bytes != null ? ` · ${esc(formatBytes(f.size_bytes))}` : ''}</span></li>`).join('')
      + '</ul>';
  }

  const title = note.title || t('notes.untitled');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>`
    + `${note.title ? `<h1 class="title">${esc(note.title)}</h1>` : ''}`
    + `${meta.length ? `<p class="meta">${meta.map(m => `<span>${m}</span>`).join('')}</p>` : ''}`
    + `${content}</body></html>`;
}

/** Open the print dialog for a note (where Save as PDF lives too). */
export async function printNote(note, options = {}) {
  const html = await noteToPrintHtml(note, options);
  const title = note.title || options.t?.('notes.untitled') || 'Note';
  if (isNative) {
    const { registerPlugin } = await import('@capacitor/core');
    const NotePrint = registerPlugin('NotePrint');
    await NotePrint.print({ html, title: title.slice(0, 100) });
    return;
  }
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0', opacity: '0' });
  document.body.appendChild(frame);
  await new Promise((resolve) => { frame.onload = resolve; frame.srcdoc = html; });
  const doc = frame.contentDocument;
  // Pictures are data already; give them a moment to decode before the dialog opens.
  await Promise.all([...doc.images].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; setTimeout(r, 3000); })));
  const win = frame.contentWindow;
  const back = document.activeElement;
  const cleanup = () => setTimeout(() => frame.remove(), 500);
  win.addEventListener('afterprint', cleanup, { once: true });
  win.print();
  // Keys go back to the note (Escape, typing) once the dialog closes, not to the hidden frame.
  if (document.activeElement === frame) (back && back !== document.body ? back : document.body).focus?.();
  if (document.activeElement === frame) frame.blur();
  setTimeout(cleanup, 60_000);
}
