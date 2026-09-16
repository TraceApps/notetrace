<script>
  /**
   * FileAttachments: a note's files as chips, the way Apple Notes shows a
   * document: a picture of it (a PDF's first page) or its kind's icon, its
   * name, and what it is. Tapping one opens it in the viewer.
   */
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { fileIcon, fileTypeLabel, formatBytes, displayName } from '../../lib/file-kinds.js';

  export let files = [];          // file attachments (and placeholders with pending: true)
  export let editable = false;
  export let busy = {};           // uuid -> a state word while the app reads a file

  const dispatch = createEventDispatcher();
  let broken = {};                // uuid -> true when a preview didn't load
</script>

{#if files.length}
  <ul class="files" aria-label={$_('files.title')}>
    {#each files as f (f.uuid)}
      <li class="file" class:pending={f.pending}>
        <button class="file-open" on:click={() => !f.pending && dispatch('open', f)} disabled={f.pending}
          aria-label={`${$_('files.open')}: ${displayName(f)}`}>
          <span class="thumb" class:has-preview={f.preview_url && !broken[f.uuid]}>
            {#if f.preview_url && !broken[f.uuid]}
              <img src={resolveAssetUrl(f.preview_url)} alt="" loading="lazy" draggable="false"
                on:error={() => broken = { ...broken, [f.uuid]: true }} />
            {:else}
              <span class="material-symbols-rounded" class:spin={f.pending}>{f.pending ? 'progress_activity' : fileIcon(f)}</span>
            {/if}
          </span>
          <span class="info">
            <span class="name">{displayName(f)}</span>
            <span class="meta">
              {#if f.pending}{$_('files.uploading')}
              {:else if busy[f.uuid]}{$_('files.reading')}
              {:else}{fileTypeLabel(f)}{#if f.size_bytes != null}<span class="sep" aria-hidden="true">·</span>{formatBytes(f.size_bytes)}{/if}{/if}
            </span>
          </span>
        </button>
        {#if editable && !f.pending}
          <button class="file-x" on:click={() => dispatch('remove', f.uuid)} aria-label={`${$_('files.remove')}: ${displayName(f)}`}>
            <span class="material-symbols-rounded">close</span>
          </button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .files { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr)); gap: 8px; }
  .file {
    position: relative; display: flex; align-items: stretch; min-width: 0;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--text-1) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--text-1) 8%, transparent);
    transition: background 140ms ease, border-color 140ms ease;
  }
  .file:hover { background: color-mix(in srgb, var(--text-1) 9%, transparent); border-color: color-mix(in srgb, var(--text-1) 14%, transparent); }
  .file-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 7px 34px 7px 7px; text-align: left; border-radius: inherit; }
  .file-open:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .thumb {
    width: 42px; height: 50px; flex-shrink: 0; border-radius: 8px; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    background: var(--accent-dim); color: var(--accent);
  }
  .thumb.has-preview { background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
  .thumb .material-symbols-rounded { font-size: 24px; }
  .info { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .name { font-size: 14px; font-weight: 500; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { font-size: 12px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sep { margin: 0 5px; }
  .file-x {
    position: absolute; top: 50%; right: 4px; transform: translateY(-50%);
    width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
    color: var(--text-3); opacity: 0; transition: opacity 120ms ease;
  }
  .file-x .material-symbols-rounded { font-size: 18px; }
  .file:hover .file-x, .file:focus-within .file-x { opacity: 1; }
  .file-x:hover { color: var(--text-1); background: color-mix(in srgb, var(--text-1) 10%, transparent); }
  @media (pointer: coarse) { .file-x { opacity: 0.75; } }
  .pending { opacity: 0.75; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
