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
  .palette { display: flex; flex-wrap: wrap; gap: 8px; }
  .swatch {
    width: 32px; height: 32px;
    border-radius: 50%;
    background: var(--sw-bg);
    border: 1.5px solid color-mix(in srgb, var(--sw-ring) 45%, transparent);
    display: flex; align-items: center; justify-content: center;
    color: var(--text-3);
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .swatch:hover { transform: scale(1.08); }
  .swatch.selected { border: 2px solid var(--sw-ring); color: var(--sw-ring); }
  .swatch .material-symbols-rounded { font-size: 17px; }
  .swatch.selected .material-symbols-rounded { font-variation-settings: 'FILL' 0, 'wght' 700, 'GRAD' 0, 'opsz' 20; }
</style>
