// Google returns separate blocks for static weights. Give those distinct
// filenames so a bold download cannot overwrite the regular face.
export function localFontBlocks(css, slug) {
  const faces = css.split('/*').slice(1).flatMap(part => {
    const subset = part.slice(0, part.indexOf('*/')).trim();
    const body = part.slice(part.indexOf('*/') + 2);
    const url = body.match(/src: url\(([^)]+)\)/)?.[1];
    if (!url) return [];
    return [{ subset, url, family: body.match(/font-family: '([^']+)'/)?.[1],
      style: body.match(/font-style: ([^;]+);/)?.[1] || 'normal',
      weight: body.match(/font-weight: ([^;]+);/)?.[1] || '400',
      range: body.match(/unicode-range: ([^;]+);/)?.[1] }];
  });
  return faces.map(face => {
    const multiple = faces.filter(other => other.subset === face.subset).length > 1;
    const suffix = multiple ? `-${face.style}-${face.weight.replace(/\s+/g, '-')}` : '';
    const file = `${slug}-${face.subset}${suffix}.woff2`;
    const text = `/* ${face.family}: ${face.subset} */\n@font-face {\n  font-family: '${face.family}';\n  font-style: ${face.style};\n  font-weight: ${face.weight};\n  font-display: swap;\n  src: url(./${file}) format('woff2');\n${face.range ? `  unicode-range: ${face.range};\n` : ''}}`;
    return { ...face, file, css: text };
  });
}
