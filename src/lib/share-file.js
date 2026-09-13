/**
 * share-file.js: hand a Blob to the platform share sheet, with a
 * download fallback. Works on PWA (Web Share API), the Capacitor
 * WebView on Android (native share sheet via @capacitor/share), and
 * desktop browsers (download fallback).
 */

/**
 * @param {Blob}   blob     file data
 * @param {string} filename suggested filename
 * @param {string} title    share-sheet title
 * @param {string} [text]   accompanying text body
 * @returns {Promise<{ shared?: boolean, canceled?: boolean, downloaded?: boolean }>}
 */
export async function shareBlob(blob, filename, title, text) {
  // ── Capacitor native share path ───────────────────────────────────
  // The WebView's navigator.canShare reports false for files, so the
  // Web Share API path silently falls through to download. On Android,
  // write the file to Cache via Filesystem, then call @capacitor/share
  // which opens the native share sheet.
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform && Capacitor.isNativePlatform()) {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');
      const b64 = await _blobToBase64(blob);
      await Filesystem.writeFile({
        path: `exports/${filename}`,
        data: b64,
        directory: Directory.Cache,
        recursive: true,
      });
      const { uri } = await Filesystem.getUri({
        path: `exports/${filename}`,
        directory: Directory.Cache,
      });
      await Share.share({
        title: title || filename,
        url: uri,
        dialogTitle: title || 'Share',
      });
      return { shared: true };
    }
  } catch (err) {
    const msg = (err && err.message) || '';
    if (/cancel/i.test(msg)) return { shared: false, canceled: true };
    // Fall through to web paths below.
  }

  // ── Web Share API (PWA, mobile browsers that support file sharing)
  const file = new File([blob], filename, { type: blob.type });
  if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return { shared: true };
    } catch (err) {
      if (err && err.name === 'AbortError') return { shared: false, canceled: true };
      // fall through to download
    }
  }

  // ── Download fallback (desktop browsers without file share) ───────
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { shared: false, downloaded: true };
}

function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
