import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// The stylesheet used to have a permanent URL. An older service worker could
// pair its old @font-face definitions with a new typography menu indefinitely.
export function versionedFonts() {
  let filename;
  return {
    name: 'versioned-font-stylesheet',
    apply: 'build',
    buildStart() {
      const source = readFileSync(new URL('../public/fonts/fonts.css', import.meta.url), 'utf8');
      filename = `fonts/fonts-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.css`;
      this.emitFile({ type: 'asset', fileName: filename, source });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) { return html.replace(/href=(["'])(?:\.\/|\/)fonts\/fonts\.css\1/, `href="./${filename}"`); },
    },
  };
}
