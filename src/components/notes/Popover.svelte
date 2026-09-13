<script>
  /**
   * Popover: small floating panel anchored to a trigger. On phones it
   * becomes a bottom sheet, which is easier to reach than a tiny menu.
   */
  import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { portal } from '../../lib/portal.js';

  export let open = false;
  /** DOMRect of the trigger, or {x, y} for a press point. */
  export let anchor = null;

  const dispatch = createEventDispatcher();
  let panel;
  let style = '';
  let narrow = false;

  function close() { open = false; dispatch('close'); }

  async function place() {
    narrow = window.innerWidth < 600;
    if (narrow || !anchor) { style = ''; return; }
    await tick();
    if (!panel) return;
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    const ax = anchor.left ?? anchor.x, ay = anchor.bottom ?? anchor.y;
    const top = anchor.top ?? anchor.y;
    let left = Math.min(Math.max(12, ax), window.innerWidth - pw - 12);
    let y = ay + 6;
    if (y + ph > window.innerHeight - 12) y = Math.max(12, top - ph - 6);
    style = `left:${left}px; top:${y}px;`;
  }

  $: if (open) place();

  function onKey(e) { if (open && e.key === 'Escape') { e.stopPropagation(); close(); } }
  onMount(() => window.addEventListener('keydown', onKey, true));
  onDestroy(() => window.removeEventListener('keydown', onKey, true));
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="pop-backdrop" class:narrow on:click|self={close} transition:fade={{ duration: 120 }}>
    <div class="pop-panel" class:sheet={narrow} bind:this={panel} {style}
      role="dialog" aria-modal="true"
      in:fly={{ y: narrow ? 40 : 6, duration: 160 }}>
      <slot {close} />
    </div>
  </div>
{/if}

<style>
  .pop-backdrop { position: fixed; inset: 0; z-index: 300; }
  .pop-backdrop.narrow { background: var(--overlay); }
  .pop-panel {
    position: fixed;
    padding: 12px;
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    max-width: calc(100vw - 24px);
  }
  .pop-panel.sheet :global(.label-picker) { width: 100%; }
  .pop-panel.sheet {
    left: 0; right: 0; bottom: 0; top: auto;
    max-width: none;
    padding: 16px 16px calc(16px + var(--safe-bottom));
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  }
</style>
