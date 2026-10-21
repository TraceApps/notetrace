// Most existing components use pixel font sizes. Scale text at the shared CSS
// boundary while leaving Material Symbols and explicitly sized icons alone.
export function textSizeCss() {
  return {
    postcssPlugin: 'notetrace-text-size',
    Declaration(decl) {
      if (decl.prop !== 'font-size' || !/^\d+(?:\.\d+)?px$/.test(decl.value) || decl.value === '0px') return;
      const selector = decl.parent?.selector || '';
      if (/material-symbols|(?:\.|\b)[\w-]*icon[\w-]*\b|\.si\b|\.chevron\b/.test(selector)) return;
      decl.value = `calc(${decl.value} * var(--text-scale, 1))`;
    },
  };
}
