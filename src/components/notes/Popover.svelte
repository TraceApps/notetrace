<script>
  /**
   * Popover: small floating panel anchored to a trigger. On phones it
   * becomes a bottom sheet, which is easier to reach than a tiny menu.
   */
  import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { portal } from '../../lib/portal.js';
  import { dialogFocus } from '../../lib/dialog-focus.js';

  export let open = false;
  /** DOMRect of the trigger, or {x, y} for a press point. */
  export let anchor = null;
  /** Its name for screen readers, like the button that opened it. */
  export let label = '';

  const dispatch = createEventDispatcher();
  let panel;
  let style = '';
  let narrow = false;

  function close() { open = false; dispatch('close'); }

  // The part of the screen a keyboard leaves free. Contents size to it through
  // --pop-avail (the label list shrinks and scrolls rather than hiding).
  function viewport() {
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const height = vv ? vv.height : window.innerHeight;
    return { top, bottom: top + height, height, keyboard: Math.max(0, window.innerHeight - top - height) };
  }

  async function place() {
    narrow = window.innerWidth < 600;
    const vp = viewport();
    if (narrow || !anchor) {
      style = `bottom:${vp.keyboard}px; max-height:${Math.round(vp.height - 12)}px; --pop-avail:${Math.round(vp.height - 12)}px;`;
      return;
    }
    const room = Math.round(vp.height - 24);
    style = `left:-9999px; top:0; max-height:${room}px; --pop-avail:${room}px;`;
    await tick();
    if (!panel) return;
    const pw = panel.offsetWidth, ph = Math.min(panel.offsetHeight, room);
    const ax = anchor.left ?? anchor.x, ay = anchor.bottom ?? anchor.y;
    const top = anchor.top ?? anchor.y;
    const left = Math.min(Math.max(12, ax), window.innerWidth - pw - 12);
    let y = ay + 6;
    if (y + ph > vp.bottom - 12) y = top - ph - 6;
    // Neither below nor above fits (a keyboard is up): keep it inside what's visible.
    y = Math.min(Math.max(vp.top + 12, y), vp.bottom - 12 - ph);
    style = `left:${left}px; top:${y}px; max-height:${room}px; --pop-avail:${room}px;`;
  }

  $: if (open) place();

  function onKey(e) { if (open && e.key === 'Escape') { e.stopPropagation(); close(); } }
  // A keyboard opening or closing moves the popover with it.
  let _vvFrame = 0;
  function onViewport() {
    if (!open) return;
    cancelAnimationFrame(_vvFrame);
    _vvFrame = requestAnimationFrame(place);
  }
  onMount(() => {
    window.addEventListener('keydown', onKey, true);
    window.visualViewport?.addEventListener('resize', onViewport);
    window.addEventListener('resize', onViewport);
  });
  onDestroy(() => {
    window.removeEventListener('keydown', onKey, true);
    window.visualViewport?.removeEventListener('resize', onViewport);
    window.removeEventListener('resize', onViewport);
    cancelAnimationFrame(_vvFrame);
  });
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="pop-backdrop" class:narrow on:click|self={close} transition:fade={{ duration: 120 }}>
    <div class="pop-panel" class:sheet={narrow} bind:this={panel} {style}
      role="dialog" aria-modal="true" aria-label={label || undefined} tabindex="-1" use:dialogFocus
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
    overflow-y: auto; overscroll-behavior: contain;
    transition: bottom 180ms ease, top 180ms ease;
  }
  .pop-panel.sheet :global(.label-picker) { width: 100%; }
  .pop-panel.sheet {
    left: 0; right: 0; bottom: 0; top: auto;
    max-width: none;
    padding: 16px 16px calc(16px + var(--safe-bottom));
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  }
</style>
