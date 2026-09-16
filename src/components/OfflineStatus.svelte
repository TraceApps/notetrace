<script>
  // Web app: says when it's offline and when edits are waiting to sync,
  // and confirms once they have.
  import { onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { offlineState, flushOutbox } from '../lib/offline-api.js';
  import { portal } from '../lib/portal.js';

  let synced = false;
  let timer;
  let wasPending = 0;
  $: {
    const s = $offlineState;
    if (wasPending > 0 && s.pending === 0 && s.online && !s.syncing) {
      synced = true;
      clearTimeout(timer);
      timer = setTimeout(() => { synced = false; }, 2500);
    }
    wasPending = s.pending;
  }
  onDestroy(() => clearTimeout(timer));

  $: state = !$offlineState.online ? 'offline'
    : $offlineState.syncing ? 'syncing'
    : $offlineState.pending && $offlineState.error ? 'failed'
    : $offlineState.pending ? 'waiting'
    : synced ? 'synced' : null;
  $: text = state === 'offline'
      ? ($offlineState.pending ? $_('offline.offline_waiting', { values: { n: $offlineState.pending } }) : $_('offline.offline'))
    : state === 'syncing' ? $_('offline.syncing')
    : state === 'failed' ? $_('offline.failed', { values: { n: $offlineState.pending } })
    : state === 'waiting' ? $_('offline.waiting', { values: { n: $offlineState.pending } })
    : state === 'synced' ? $_('offline.synced') : '';
  $: icon = state === 'offline' ? 'cloud_off' : state === 'synced' ? 'cloud_done' : state === 'failed' ? 'sync_problem' : 'cloud_upload';
</script>

{#if state}
  <div class="offline-host" use:portal role="status" aria-live="polite">
    <button class="offline-pill" class:bad={state === 'offline' || state === 'failed'}
      title={state === 'waiting' || state === 'failed' ? $_('offline.retry') : text}
      disabled={state !== 'waiting' && state !== 'failed'}
      on:click={() => flushOutbox()}
      transition:fade|global={{ duration: 160 }}>
      <span class="material-symbols-rounded" class:spin={state === 'syncing'} aria-hidden="true">{icon}</span>
      <span>{text}</span>
    </button>
  </div>
{/if}

<style>
  :global(.offline-host) { display: contents; }
  .offline-pill {
    position: fixed; z-index: 420;
    top: calc(env(safe-area-inset-top, 0px) + 8px); left: 50%; transform: translateX(-50%);
    display: inline-flex; align-items: center; gap: 6px;
    max-width: calc(100vw - 32px);
    padding: 5px 12px 5px 10px; border-radius: 999px;
    font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: var(--text-1); background: var(--surface-2);
    border: 1px solid var(--border-strong); box-shadow: var(--shadow-md, 0 4px 16px rgba(0,0,0,.18));
  }
  .offline-pill:disabled { cursor: default; opacity: 1; }
  .offline-pill.bad { color: var(--warning, #f5a524); }
  .offline-pill .material-symbols-rounded { font-size: 17px; }
  .spin { animation: offline-spin 1.2s linear infinite; }
  @keyframes offline-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
