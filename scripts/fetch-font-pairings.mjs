// Rebuild missing pairing families from Google's published font files and
// licenses. Run manually; no user's browser ever contacts a font CDN.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { FONT_PAIRINGS } from '../src/lib/font-pairings.js';
import { localFontBlocks } from './font-css.js';

const dir = new URL('../public/fonts/', import.meta.url);
const cssFile = new URL('fonts.css', dir);
let css = readFileSync(cssFile, 'utf8');
const families = [...new Set(FONT_PAIRINGS.flatMap(p => [p.displayName, p.bodyName, p.monoName]))];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
async function read(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error(`${response.status}: ${url}`);
  return response;
}
for (const name of families) {
  if (css.includes(`font-family: '${name}';`)) continue;
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  const folder = name.toLowerCase().replace(/\s+/g, '');
  let source = `https://raw.githubusercontent.com/google/fonts/main/ofl/${folder}/`;
  let metadata;
  try { metadata = await read(source + 'METADATA.pb').then(r => r.text()); }
  catch (error) {
    if (!error.message.startsWith('404:')) throw error;
    source = `https://raw.githubusercontent.com/google/fonts/main/apache/${folder}/`;
    metadata = await read(source + 'METADATA.pb').then(r => r.text());
  }
  const apache = /license:\s*"APACHE2"/.test(metadata);
  const licenseName = apache ? 'LICENSE.txt' : 'OFL.txt';
  const license = await read(source + licenseName).then(r => r.text());
  if (!(apache ? /Apache License/.test(license) : /SIL OPEN FONT LICENSE/i.test(license))) throw Error(`License needs review: ${name}`);
  const axis = [...metadata.matchAll(/axes\s*\{([^}]+)\}/g)].map(m => m[1]).find(m => /tag:\s*"wght"/.test(m));
  const weights = axis ? `${Math.max(400, Number(axis.match(/min_value:\s*([\d.]+)/)[1]))}..${Math.min(700, Number(axis.match(/max_value:\s*([\d.]+)/)[1]))}`
    : [...new Set([...metadata.matchAll(/fonts\s*\{([^}]+)\}/g)].map(m => m[1]).filter(m => /style:\s*"normal"/.test(m)).map(m => Number(m.match(/weight:\s*(\d+)/)[1])).filter(w => w >= 400 && w <= 700))].sort((a,b) => a-b).join(';');
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:wght@${weights}&display=swap`;
  const remoteCss = await read(url, { 'User-Agent': UA }).then(r => r.text());
  const blocks = localFontBlocks(remoteCss, slug);
  if (!blocks.length) throw Error(`No font faces: ${name}`);
  for (const block of blocks) {
    const bytes = Buffer.from(await read(block.url).then(r => r.arrayBuffer()));
    if (bytes.toString('ascii', 0, 4) !== 'wOF2') throw Error(`Invalid font: ${block.file}`);
    writeFileSync(new URL(block.file, dir), bytes);
  }
  writeFileSync(new URL(`${slug}-${licenseName}`, dir), license);
  if (apache) writeFileSync(new URL(`${slug}-NOTICE.txt`, dir), `${name}\n${metadata.match(/copyright:\s*"([^\n]+)"/)?.[1] || ''}\nSource: ${source}\n`);
  css += '\n' + blocks.map(b => b.css).join('\n\n') + '\n';
  writeFileSync(cssFile, css);
  console.log(`${name}: ${blocks.length} local faces; ${apache ? 'Apache 2.0' : 'OFL'} verified`);
}
// Keep the license inventory complete, including already bundled families.
const licenseFile = new URL('../LICENSES.md', import.meta.url);
let licenses = readFileSync(licenseFile, 'utf8');
for (const name of families) {
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  const apache = existsSync(new URL(`${slug}-LICENSE.txt`, dir));
  const licenseName = apache ? 'LICENSE.txt' : 'OFL.txt';
  if (licenses.includes(`**${name}**`) || !existsSync(new URL(`${slug}-${licenseName}`, dir))) continue;
  licenses = licenses.replace('| **Material Symbols Rounded**', `| **${name}** | ${apache ? '[Apache License 2.0][apache]' : '[SIL Open Font License 1.1][ofl]'} | \`public/fonts/${slug}-*.woff2\`, \`public/fonts/${slug}-${licenseName}\` |\n| **Material Symbols Rounded**`);
}
writeFileSync(licenseFile, licenses);
