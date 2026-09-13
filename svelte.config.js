import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  // Svelte 5 compat shim — keep treating the codebase as Svelte 4.
  // `componentApi: 4` makes `new App({...})` work (Svelte 5's new
  // default is to expect mount() instead of `new`). `runes: false`
  // forces every file into legacy reactive mode regardless of script
  // content, so the compiler doesn't auto-promote `$:` reactives in
  // App.svelte to $effect() — those fire during component construction
  // and throw `effect_orphan`, which surfaced to the user as the
  // "Database Error" fallback (the catch in main.js was catching App's
  // synchronous throw, not a DB failure).
  //
  // To migrate a single component to runes later, add
  // <svelte:options runes /> to that file.
  compilerOptions: {
    runes: false,
    compatibility: { componentApi: 4 },
  },
};
