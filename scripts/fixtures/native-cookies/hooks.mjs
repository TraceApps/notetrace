const here = new URL('./', import.meta.url);
const src = new URL('../../../src/', import.meta.url).href;
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('@capacitor/') || spec.startsWith('@capacitor-community/') || spec.startsWith('@aparajita/')) {
    return { url: new URL('capacitor.mjs', here).href, shortCircuit: true };
  }
  return next(spec, ctx);
}
// Vite's import.meta.env does not exist in Node.
export async function load(url, ctx, next) {
  // i18n/index.js imports en.json without an import attribute, as Vite allows.
  if (url.startsWith(src) && url.endsWith('.json')) {
    const { readFile } = await import('node:fs/promises');
    const json = await readFile(new URL(url), 'utf8');
    return { format: 'module', source: `export default ${json};`, shortCircuit: true };
  }
  const r = await next(url, ctx);
  if (url.startsWith(src) && r.source) {
    const code = String(r.source).replaceAll('import.meta.env', '({DEV:false,PROD:true,MODE:"production"})');
    return { ...r, source: code, format: r.format || 'module' };
  }
  return r;
}
