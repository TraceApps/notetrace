<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { NoteApi } from '../../lib/api.js';
  import { relativeTime, shortDate } from '../../lib/relative-time.js';
  import { markdownToPreview } from '../../lib/note-preview.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { showError, showSuccess } from '../../stores/toast.js';

  export let noteId;
  const dispatch = createEventDispatcher();

  let versions = [];
  let loading = true;
  let selectedId = null;
  let busy = false;

  $: selected = versions.find(v => v.id === selectedId) || versions[0] || null;

  onMount(async () => {
    try {
      versions = await NoteApi.getVersions(noteId);
      selectedId = versions[0]?.id ?? null;
    } catch (e) {
      showError(e.message || $_('notes.versions_load_failed'));
    } finally {
      loading = false;
    }
  });

  async function restore() {
    if (!selected || busy) return;
    const ok = await confirmDialog({
      title: $_('notes.version_restore_title'),
      message: $_('notes.version_restore_message'),
      confirmText: $_('notes.restore'),
    });
    if (!ok) return;
    busy = true;
    try {
      const note = await NoteApi.restoreVersion(noteId, selected.id);
      showSuccess($_('notes.version_restored'));
      dispatch('restored', note);
    } catch (e) {
      showError(e.message || $_('notes.version_restore_failed'));
    } finally {
      busy = false;
    }
  }
</script>

<div class="history">
  <header class="h-head">
    <button class="btn-icon" on:click={() => dispatch('close')} aria-label={$_('common.back')}>
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <h2>{$_('notes.version_history')}</h2>
  </header>

  {#if loading}
    <p class="h-empty">{$_('common.loading')}</p>
  {:else if !versions.length}
    <div class="h-empty">
      <span class="material-symbols-rounded">history</span>
      <p>{$_('notes.versions_empty')}</p>
    </div>
  {:else}
    <div class="h-body">
      <ul class="h-list">
        {#each versions as v (v.id)}
          <li>
            <button class="h-row" class:on={selected?.id === v.id} on:click={() => selectedId = v.id}>
              <span class="h-when" title={shortDate(v.created_at)}>{relativeTime(v.created_at)}</span>
              {#if v.reason === 'conflict'}
                <span class="h-badge">{$_('notes.version_conflict')}</span>
              {:else if v.reason === 'restore'}
                <span class="h-badge muted">{$_('notes.version_before_restore')}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
      {#if selected}
        <article class="h-preview">
          {#if selected.title}<h3>{selected.title}</h3>{/if}
          {#if selected.kind === 'checklist'}
            <ul class="h-items">
              {#each selected.items as it}
                <li class:done={it.checked}>
                  <span class="material-symbols-rounded">{it.checked ? 'check_box' : 'check_box_outline_blank'}</span>
                  {it.text}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="h-text">{markdownToPreview(selected.body_md, 4000)}</p>
          {/if}
          <button class="btn btn-primary h-restore" on:click={restore} disabled={busy}>
            <span class="material-symbols-rounded">restore</span>
            {$_('notes.version_restore_this')}
          </button>
        </article>
      {/if}
    </div>
  {/if}
</div>

<style>
  .history { display: flex; flex-direction: column; gap: 12px; min-height: 0; flex: 1; }
  .h-head { display: flex; align-items: center; gap: 10px; }
  .h-head h2 { font-size: 18px; font-weight: 600; }
  .h-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 12px; color: var(--text-3); text-align: center; }
  .h-empty .material-symbols-rounded { font-size: 36px; }
  .h-body { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 16px; min-height: 0; }
  @media (max-width: 640px) { .h-body { grid-template-columns: 1fr; } }
  .h-list { list-style: none; display: flex; flex-direction: column; gap: 2px; max-height: 60vh; overflow-y: auto; }
  .h-row {
    width: 100%; min-height: 44px; padding: 8px 12px;
    display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
    border-radius: 10px; text-align: left;
    color: var(--text-2); font-size: 14px;
  }
  .h-row:hover { background: color-mix(in srgb, var(--text-1) 6%, transparent); }
  .h-row.on { background: var(--accent-dim); color: var(--accent); }
  .h-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 99px; background: color-mix(in srgb, var(--warning) 18%, transparent); color: var(--warning); }
  .h-badge.muted { background: color-mix(in srgb, var(--text-1) 8%, transparent); color: var(--text-2); }
  .h-preview {
    display: flex; flex-direction: column; gap: 10px;
    padding: 16px; border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--text-1) 4%, transparent);
    border: 1px solid var(--border);
    max-height: 60vh; overflow-y: auto;
  }
  .h-preview h3 { font-family: var(--font-note-title); font-weight: 500; font-size: 22px; }
  .h-text { white-space: pre-line; font-size: 15px; line-height: 1.6; color: var(--text-2); overflow-wrap: anywhere; }
  .h-items { list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: 15px; color: var(--text-2); }
  .h-items li { display: flex; gap: 8px; align-items: flex-start; }
  .h-items .material-symbols-rounded { font-size: 18px; margin-top: 2px; }
  .h-items li.done { text-decoration: line-through; color: var(--text-3); }
  .h-restore { align-self: flex-start; margin-top: 4px; }
</style>
