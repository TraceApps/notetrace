/**
 * window-size.js: how much room the app has, as Material-style size classes.
 *
 *   compact   under 600px wide: phones and a folded foldable's cover screen
 *   medium    600 to 1023px:    an unfolded foldable, a small tablet, a narrow window
 *   expanded  1024px and up:    tablets in landscape and desktops
 *
 * `contentWidth` is the width left for the page beside a pinned sidebar;
 * App.svelte keeps it current.
 */
import { readable, writable, derived } from 'svelte/store';
import { forceMobileLayout } from './settings.js';

import { sizeClassFor } from '../lib/fold-core.js';
export { sizeClassFor };

const read = () => ({ width: window.innerWidth, height: window.innerHeight });

export const viewport = readable(typeof window !== 'undefined' ? read() : { width: 1024, height: 768 }, (set) => {
  if (typeof window === 'undefined') return undefined;
  const on = () => set(read());
  window.addEventListener('resize', on);
  return () => window.removeEventListener('resize', on);
});

export const sizeClass = derived([viewport, forceMobileLayout], ([$v, $force]) => ($force ? 'compact' : sizeClassFor($v.width)));

export const contentWidth = writable(typeof window !== 'undefined' ? window.innerWidth : 1024);
