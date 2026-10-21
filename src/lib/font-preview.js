import { themeFontFamilies } from './font-themes.js';

export function createFontPreviewLoader(fonts, onState) {
  let generation = 0;
  return {
    async load(theme) {
      const current = ++generation;
      onState('loading');
      try {
        const families = themeFontFamilies(theme);
        const loaded = await Promise.all(families.map(name => fonts.load(`16px "${name}"`, 'Notes ideas 0123456789')));
        // FontFaceSet.load resolves to [] for a family absent from the CSS.
        // Computed font-family alone would incorrectly report a good preview.
        const ready = loaded.every(faces => faces.length > 0 && faces.every(face => face.status === 'loaded'));
        if (current === generation) onState(ready ? 'ready' : 'failed');
      } catch { if (current === generation) onState('failed'); }
    },
    cancel() { generation++; },
  };
}
