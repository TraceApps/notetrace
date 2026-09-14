<script>
  /**
   * TraceActions: Tidy Up, Summarize, and Make a Checklist for a text note.
   * Shows Trace's result first; nothing changes until the user applies it,
   * and applying keeps the previous text in version history.
   */
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { askTrace, TRACE_ACTIONS, cleanTraceReply, checklistLines } from '../../lib/trace-run.js';
  import { markdownToPreview } from '../../lib/note-preview.js';

  export let title = '';
  export let body = '';

  const dispatch = createEventDispatcher();
  let action = null;     // 'tidy' | 'summarize' | 'checklist'
  let busy = false;
  let result = '';
  let error = '';

  async function run(kind) {
    action = kind;
    busy = true;
    result = '';
    error = '';
    try {
      const a = TRACE_ACTIONS[kind];
      result = cleanTraceReply(await askTrace({ systemPrompt: a.system, prompt: a.prompt(title, body) }));
      if (!result) error = $_('trace_actions.empty');
    } catch (e) {
      error = e?.message || $_('trace_actions.failed');
    } finally {
      busy = false;
    }
  }

  $: items = action === 'checklist' ? checklistLines(result) : [];

  function apply(mode) {
    if (action === 'checklist') dispatch('checklist', { items });
    else if (action === 'summarize') dispatch(mode === 'replace' ? 'replace' : 'prepend', { markdown: result });
    else dispatch('replace', { markdown: result });
  }
</script>

<div class="ta">
  {#if !action}
    <p class="ta-title">{$_('trace_actions.title')}</p>
    <button class="ta-row" on:click={() => run('tidy')}>
      <span class="material-symbols-rounded">auto_fix_high</span>
      <span><strong>{$_('trace_actions.tidy')}</strong><small>{$_('trace_actions.tidy_desc')}</small></span>
    </button>
    <button class="ta-row" on:click={() => run('summarize')}>
      <span class="material-symbols-rounded">short_text</span>
      <span><strong>{$_('trace_actions.summarize')}</strong><small>{$_('trace_actions.summarize_desc')}</small></span>
    </button>
    <button class="ta-row" on:click={() => run('checklist')}>
      <span class="material-symbols-rounded">checklist</span>
      <span><strong>{$_('trace_actions.checklist')}</strong><small>{$_('trace_actions.checklist_desc')}</small></span>
    </button>
  {:else}
    <p class="ta-title">{$_(`trace_actions.${action}`)}</p>
    {#if busy}
      <p class="ta-status" aria-live="polite"><span class="material-symbols-rounded spin">progress_activity</span>{$_('trace_actions.working')}</p>
    {:else if error}
      <p class="ta-error" role="alert">{error}</p>
      <div class="ta-buttons">
        <button class="btn btn-secondary" on:click={() => action = null}>{$_('common.back')}</button>
        <button class="btn btn-primary" on:click={() => run(action)}>{$_('trace_actions.try_again')}</button>
      </div>
    {:else}
      <div class="ta-result">
        {#if action === 'checklist'}
          <ul>{#each items as it}<li><span class="box"></span>{it}</li>{/each}</ul>
        {:else}
          <p>{markdownToPreview(result, 4000)}</p>
        {/if}
      </div>
      <div class="ta-buttons">
        <button class="btn btn-secondary" on:click={() => dispatch('close')}>{$_('common.cancel')}</button>
        <button class="btn btn-secondary" on:click={() => run(action)}>{$_('trace_actions.try_again')}</button>
        {#if action === 'summarize'}
          <button class="btn btn-primary" on:click={() => apply('prepend')}>{$_('trace_actions.add_to_top')}</button>
        {:else}
          <button class="btn btn-primary" on:click={() => apply('replace')} disabled={action === 'checklist' && !items.length}>
            {action === 'checklist' ? $_('trace_actions.use_checklist') : $_('trace_actions.use_this')}
          </button>
        {/if}
      </div>
      <p class="ta-hint">{$_('trace_actions.history_hint')}</p>
    {/if}
  {/if}
</div>

<style>
  .ta { display: flex; flex-direction: column; gap: 8px; width: 380px; max-width: 100%; }
  :global(.pop-panel.sheet) .ta { width: 100%; }
  .ta-title { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .ta-row {
    display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 6px 8px; margin: 0 -6px;
    border-radius: 10px; text-align: left; color: var(--text-1);
  }
  .ta-row:hover { background: color-mix(in srgb, var(--text-1) 7%, transparent); }
  .ta-row .material-symbols-rounded { color: var(--accent); font-size: 21px; }
  .ta-row strong { display: block; font-size: 14px; font-weight: 500; }
  .ta-row small { display: block; font-size: 12px; color: var(--text-3); }
  .ta-status { display: flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 14px; padding: 12px 0; }
  .spin { animation: spin 1s linear infinite; font-size: 20px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .ta-error { color: var(--danger); font-size: 13px; }
  .ta-result {
    max-height: 45vh; overflow: auto; padding: 10px 12px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-md);
    font-size: 14px; line-height: 1.5; color: var(--text-1); white-space: pre-line;
  }
  .ta-result ul { list-style: none; display: flex; flex-direction: column; gap: 6px; white-space: normal; }
  .ta-result li { display: flex; gap: 8px; align-items: flex-start; }
  .box { width: 14px; height: 14px; margin-top: 3px; border: 1.5px solid var(--text-3); border-radius: 4px; flex-shrink: 0; }
  .ta-buttons { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
  .ta-buttons .btn { height: 38px; }
  .ta-hint { font-size: 11px; color: var(--text-3); text-align: right; }
</style>
