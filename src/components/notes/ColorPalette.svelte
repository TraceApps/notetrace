<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { NOTE_COLORS } from '../../lib/note-colors.js';

  export let value = null;
  const dispatch = createEventDispatcher();
</script>

<div class="palette" role="radiogroup" aria-label={$_('notes.color')}>
  {#each NOTE_COLORS as c (c.key)}
    <button
      type="button"
      class="swatch"
      class:selected={(value || null) === c.value}
      style="--sw-bg: var(--note-{c.key}-bg); --sw-ring: {c.dot};"
      role="radio"
      aria-checked={(value || null) === c.value}
      title={$_(`notes.color_${c.key}`)}
      aria-label={$_(`notes.color_${c.key}`)}
      on:click={() => dispatch('select', c.value)}
    >
      {#if !c.value}
        <span class="material-symbols-rounded">format_color_reset</span>
      {:else if (value || null) === c.value}
        <span class="material-symbols-rounded">check</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .palette { display: grid; grid-template-columns: repeat(6, 32px); gap: 8px; }
  .swatch {
    width: 32px; height: 32px;
    border-radius: 50%;
    /* The note's tint, with its color as a bold ring so sixteen stay easy to tell apart. */
    background: radial-gradient(circle, var(--sw-bg) 0 45%, color-mix(in srgb, var(--sw-ring) 35%, var(--sw-bg)) 100%);
    border: 2.5px solid color-mix(in srgb, var(--sw-ring) 85%, transparent);
    display: flex; align-items: center; justify-content: center;
    color: var(--text-3);
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .swatch:hover { transform: scale(1.08); }
  .swatch.selected { border-color: var(--sw-ring); color: var(--sw-ring); box-shadow: 0 0 0 2px var(--surface-1), 0 0 0 4px var(--sw-ring); }
  .swatch .material-symbols-rounded { font-size: 17px; }
  .swatch.selected .material-symbols-rounded { font-variation-settings: 'FILL' 0, 'wght' 700, 'GRAD' 0, 'opsz' 20; }
</style>
