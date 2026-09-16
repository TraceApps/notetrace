<script>
  /** ImageViewer: full-screen view of a note's images, with arrows and swipe. */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { fade } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';
  import { dialogFocus } from '../../lib/dialog-focus.js';
  import { onBack } from '../../lib/back-stack.js';
  import { resolveAssetUrl } from '../../lib/platform.js';

  export let attachments = [];
  export let index = 0;
  /** Trace can read text in images, and the note can take it. */
  export let canRead = false;
  export let canAdd = false;
  export let busy = {};
  let copied = false;

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
  let releaseBack = () => {};
  onMount(() => { window.addEventListener('keydown', onKey, true); releaseBack = onBack(close); });
  onDestroy(() => { window.removeEventListener('keydown', onKey, true); releaseBack(); });
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div use:portal class="viewer" role="dialog" aria-modal="true" tabindex="-1" use:dialogFocus aria-label={$_('attachments.image')}
  in:fade={{ duration: 140 }} on:click|self={close}
  on:touchstart={(e) => { startX = e.touches[0].clientX; }}
  on:touchend={(e) => { if (startX == null) return; const dx = e.changedTouches[0].clientX - startX; startX = null; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); }}>
  {#if current}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
    <img src={resolveAssetUrl(current.url)} alt="" on:click|self={close} />
  {/if}
  <button class="v-btn v-close" on:click={close} aria-label={$_('common.close')}>
    <span class="material-symbols-rounded">close</span>
  </button>
  {#if current && (current.extracted_text || canRead)}
    <div class="v-text">
      {#if current.extracted_text}
        <p class="v-text-title">{$_('trace_extract.image_text')}</p>
        <p class="v-text-body">{current.extracted_text}</p>
        <div class="v-text-actions">
          <button on:click={async () => { try { await navigator.clipboard.writeText(current.extracted_text); copied = true; setTimeout(() => copied = false, 1500); } catch {} }}>
            <span class="material-symbols-rounded">content_copy</span>{copied ? $_('trace_extract.copied') : $_('trace_extract.copy')}
          </button>
          {#if canAdd}
            <button on:click={() => dispatch('addtext', current.extracted_text)}>
              <span class="material-symbols-rounded">note_add</span>{$_('trace_extract.add_to_note')}
            </button>
          {/if}
        </div>
      {:else}
        <button class="v-read" on:click={() => dispatch('read', current)} disabled={busy[current.uuid]}>
          <span class="material-symbols-rounded" class:spin={busy[current.uuid]}>{busy[current.uuid] ? 'progress_activity' : 'document_scanner'}</span>
          {busy[current.uuid] ? $_('trace_extract.reading') : $_('trace_extract.read_text')}
        </button>
      {/if}
    </div>
  {/if}
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
  .v-text {
    position: absolute; left: 50%; bottom: 44px; transform: translateX(-50%);
    width: min(560px, calc(100% - 32px)); max-height: 34vh; overflow: auto;
    padding: 12px 14px; border-radius: 14px;
    background: rgba(20, 20, 26, 0.92); color: #f1f1f4; border: 1px solid rgba(255,255,255,0.12);
  }
  .v-text:has(.v-read) { width: auto; padding: 6px; }
  .v-text-title { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.6; margin-bottom: 6px; }
  .v-text-body { font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
  .v-text-actions { display: flex; gap: 6px; margin-top: 8px; }
  .v-text-actions button, .v-read { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 9px; color: #fff; font-size: 13px; background: rgba(255,255,255,0.1); }
  .v-text-actions button:hover, .v-read:hover { background: rgba(255,255,255,0.2); }
  .v-text .material-symbols-rounded { font-size: 18px; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
