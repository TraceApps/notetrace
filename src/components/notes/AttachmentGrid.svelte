<script>
  /**
   * AttachmentGrid: a note's images, above its text or checklist.
   * One image fills the width; two sit side by side; more form a grid.
   * On cards the grid shows up to four, with "+N" on the last.
   */
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { resolveAssetUrl } from '../../lib/platform.js';

  export let attachments = [];
  /** 'card' | 'editor' */
  export let size = 'editor';
  export let editable = false;
  /** Placeholders while images upload. */
  export let pending = 0;

  const dispatch = createEventDispatcher();
  const CARD_MAX = 4;

  $: shown = size === 'card' ? attachments.slice(0, CARD_MAX) : attachments;
  $: extra = size === 'card' ? attachments.length - shown.length : 0;
  $: total = shown.length + pending;
  $: layout = total === 1 ? 'one' : total === 2 ? 'two' : 'many';
  const ratio = (a) => (a.width && a.height ? `${a.width} / ${a.height}` : '4 / 3');
</script>

{#if total}
  <div class="grid {size} {layout}">
    {#each shown as a, i (a.uuid)}
      <div class="cell">
        {#if size === 'editor'}
          <button type="button" class="open" on:click={() => dispatch('open', i)} aria-label={$_('attachments.open_image')}>
            <img src={resolveAssetUrl(a.url)} alt="" loading="lazy" draggable="false" style={layout === 'one' ? `aspect-ratio:${ratio(a)}` : ''} />
          </button>
        {:else}
          <img src={resolveAssetUrl(a.url)} alt="" loading="lazy" draggable="false" style={layout === 'one' ? `aspect-ratio:${ratio(a)}` : ''} />
        {/if}
        {#if a.is_drawing || a.drawing}
          <span class="draw-mark" title={$_('drawing.title')} aria-hidden="true"><span class="material-symbols-rounded">draw</span></span>
        {/if}
        {#if extra > 0 && i === shown.length - 1}
          <span class="more">+{extra}</span>
        {/if}
        {#if editable}
          <button type="button" class="remove" on:click|stopPropagation={() => dispatch('remove', a.uuid)} aria-label={$_('attachments.remove_image')}>
            <span class="material-symbols-rounded">close</span>
          </button>
        {/if}
      </div>
    {/each}
    {#each Array(pending) as _p}
      <div class="cell placeholder" aria-label={$_('attachments.uploading')}>
        <span class="material-symbols-rounded spin">progress_activity</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .grid { display: grid; gap: 4px; overflow: hidden; }
  .grid.one { grid-template-columns: 1fr; }
  .grid.two { grid-template-columns: 1fr 1fr; }
  .grid.many { grid-template-columns: repeat(3, 1fr); }
  .grid.card.many { grid-template-columns: 1fr 1fr; }
  .grid.card { margin: -16px -18px 0; border-radius: var(--radius-lg) var(--radius-lg) 0 0; }
  .grid.editor { border-radius: var(--radius-md); }

  .cell { position: relative; overflow: hidden; background: color-mix(in srgb, var(--text-1) 6%, transparent); }
  .two .cell, .many .cell { aspect-ratio: 1; }
  .cell img { display: block; width: 100%; height: 100%; object-fit: cover; }
  /* One image: full width at its own shape, capped in height. */
  .one .cell img { height: auto; max-height: 420px; }
  .card.one .cell img { max-height: 260px; }
  .open { display: block; width: 100%; height: 100%; padding: 0; cursor: zoom-in; }

  .more {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.45); color: #fff; font-size: 22px; font-weight: 600;
  }
  .remove {
    position: absolute; top: 6px; right: 6px; width: 30px; height: 30px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.55); color: #fff;
    opacity: 0; transition: opacity var(--dur-fast);
  }
  .remove .material-symbols-rounded { font-size: 18px; }
  .cell:hover .remove, .remove:focus-visible { opacity: 1; }
  @media (hover: none) { .remove { opacity: 1; } }

  .placeholder { display: flex; align-items: center; justify-content: center; color: var(--text-3); min-height: 120px; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* A drawing opens for editing; a small brush says so. */
  .draw-mark {
    position: absolute; left: 6px; bottom: 6px; width: 24px; height: 24px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; pointer-events: none;
    background: rgba(15, 16, 20, 0.62); color: #fff;
  }
  .draw-mark .material-symbols-rounded { font-size: 15px; }
  .card .draw-mark { width: 20px; height: 20px; border-radius: 6px; }
  .card .draw-mark .material-symbols-rounded { font-size: 13px; }
</style>
