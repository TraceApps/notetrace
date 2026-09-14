<script>
  /** ImageViewer: full-screen view of a note's images, with arrows and swipe. */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { fade } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';
  import { resolveAssetUrl } from '../../lib/platform.js';

  export let attachments = [];
  export let index = 0;

  const dispatch = createEventDispatcher();
  let startX = null;

  $: current = attachments[Math.min(index, attachments.length - 1)];
  const go = (d) => { if (attachments.length > 1) index = (index + d + attachments.length) % attachments.length; };
  const close = () => dispatch('close');

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
  }
  onMount(() => window.addEventListener('keydown', onKey, true));
  onDestroy(() => window.removeEventListener('keydown', onKey, true));
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div use:portal class="viewer" role="dialog" aria-modal="true" aria-label={$_('attachments.image')}
  in:fade={{ duration: 140 }} on:click|self={close}
  on:touchstart={(e) => { startX = e.touches[0].clientX; }}
  on:touchend={(e) => { if (startX == null) return; const dx = e.changedTouches[0].clientX - startX; startX = null; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); }}>
  {#if current}
    <img src={resolveAssetUrl(current.url)} alt="" on:click|self={close} />
  {/if}
  <button class="v-btn v-close" on:click={close} aria-label={$_('common.close')}>
    <span class="material-symbols-rounded">close</span>
  </button>
  {#if attachments.length > 1}
    <button class="v-btn v-prev" on:click={() => go(-1)} aria-label={$_('attachments.previous')}>
      <span class="material-symbols-rounded">chevron_left</span>
    </button>
    <button class="v-btn v-next" on:click={() => go(1)} aria-label={$_('attachments.next')}>
      <span class="material-symbols-rounded">chevron_right</span>
    </button>
    <span class="v-count">{index + 1} / {attachments.length}</span>
  {/if}
</div>

<style>
  .viewer {
    position: fixed; inset: 0; z-index: 3000;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.92);
    padding: 56px 16px;
  }
  img { max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; }
  .v-btn {
    position: absolute; width: 44px; height: 44px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: rgba(255, 255, 255, 0.12); color: #fff;
  }
  .v-btn:hover { background: rgba(255, 255, 255, 0.22); }
  .v-close { top: 12px; right: 12px; }
  .v-prev { left: 12px; top: 50%; transform: translateY(-50%); }
  .v-next { right: 12px; top: 50%; transform: translateY(-50%); }
  .v-count { position: absolute; bottom: 16px; color: rgba(255, 255, 255, 0.8); font-size: 13px; }
</style>
