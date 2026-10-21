/**
 * Download a Google Fonts family as local files, one per script subset, and
 * emit @font-face blocks that keep Google's unicode-range split so a browser
 * still fetches only the scripts a page needs.
 *
 * Usage: node fetch-fonts.mjs <public/fonts dir> <slug> "<css2 query>"
 *   node fetch-fonts.mjs ../../nutritrace/public/fonts inter "family=Inter:wght@300..700"
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { localFontBlocks } from './font-css.js';

const [dir, slug, query] = process.argv.slice(2);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const css = await (await fetch(`https://fonts.googleapis.com/css2?${query}&display=swap`, { headers: { 'User-Agent': UA } })).text();
if (!css.includes('@font-face')) throw new Error(`no @font-face for ${query}: ${css.slice(0, 200)}`);

mkdirSync(dir, { recursive: true });
const blocks = localFontBlocks(css, slug);
for (const block of blocks) {
  const bytes = Buffer.from(await (await fetch(block.url, { headers: { 'User-Agent': UA } })).arrayBuffer());
  writeFileSync(join(dir, block.file), bytes);
  console.log(`  ${block.file.padEnd(28)} ${(bytes.length / 1024).toFixed(0)} KB`);
}
writeFileSync(join(dir, `${slug}.generated.css`), blocks.map(b => b.css).join('\n\n') + '\n');
console.log(`  -> ${slug}.generated.css (${blocks.length} faces)`);
