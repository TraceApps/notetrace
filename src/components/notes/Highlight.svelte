<script>
  /** Text with the search terms marked. */
  import { highlightParts } from '../../lib/highlight.js';
  export let text = '';
  export let terms = [];
</script>

{#each highlightParts(text, terms) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}

<style>
  mark { background: color-mix(in srgb, var(--accent) 35%, transparent); color: inherit; border-radius: 3px; padding: 0 1px; }
</style>
