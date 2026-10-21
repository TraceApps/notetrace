<script>
  /**
   * TraceActions: Tidy Up, Expand, Summarize, Make a Checklist, and the
   * user's own instruction for a text note (TraceApps/notetrace#23).
   * Shows Trace's result first; nothing changes until the user applies it,
   * and applying keeps the previous text in version history.
   */
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { askTrace, TRACE_ACTIONS, cleanTraceReply, checklistLines } from '../../lib/trace-run.js';
  import { markdownToPreview } from '../../lib/note-preview.js';
  import { closeStep, createAsk } from '../../lib/trace-close.js';

  export let title = '';
  export let body = '';
  /**
   * True while Trace is working or an answer hasn't been used yet: the popup
   * then ignores a click outside, which used to close it and lose the answer
   * (TraceApps/notetrace#35).
   */
  export let holding = false;

  const dispatch = createEventDispatcher();
  let action = null;     // 'tidy' | 'expand' | 'summarize' | 'checklist' | 'custom'
  let busy = false;
  let result = '';
  let error = '';
  // Your own instruction: typed first, then run like the others.
  let instruction = '';
  let asking = false;
  let instructionEl;
  // The request running now: stopping it stops the request.
  const asker = createAsk(askTrace);
  // Asked before an answer not used yet is thrown away.
  let confirmDiscard = false;
  // The note's text when Trace was asked: if it changed since, using the
  // answer in its place asks first, so newer text isn't dropped.
  let askedBody = '';
  let confirmChanged = false;
  // The answer's main button, the question's Keep and the changed-note
  // question's first button: focus moves to what's on screen (a removed
  // button left it on the page, where a screen reader says nothing).
  let mainBtn, keepBtn, changedBtn;

  $: waiting = !busy && !error && !!action && !!result;
  $: holding = busy || waiting;

  async function run(kind) {
    if (kind === 'custom' && !instruction.trim()) return;
    action = kind;
    asking = false;
    confirmDiscard = confirmChanged = false;
    busy = true;
    result = '';
    error = '';
    askedBody = body;
    const a = TRACE_ACTIONS[kind];
    const out = await asker.run({ systemPrompt: a.system, prompt: a.prompt(title, body, instruction) });
    // Cancelled, or a newer request took its place: nothing to say.
    if (out.cancelled) return;
    busy = false;
    if (out.error) error = out.error?.message || $_('trace_actions.failed');
    else {
      result = cleanTraceReply(out.reply);
      if (!result) error = $_('trace_actions.empty');
    }
    focusSoon(() => mainBtn);
  }

  /** Stop what Trace is working on. */
  function stop() {
    asker.stop();
    busy = false;
  }

  async function focusSoon(get) {
    await tick();
    get()?.focus();
  }
  $: if (confirmDiscard) focusSoon(() => keepBtn);
  $: if (confirmChanged) focusSoon(() => changedBtn);

  /**
   * Asked by the popup before Escape or back closes it: what's running is
   * cancelled; an answer not used yet is only dropped once you say so, and
   * Escape or back on that question keeps it.
   */
  export function requestClose() {
    const step = closeStep({ busy, waiting, asking: confirmDiscard || confirmChanged });
    if (step === 'stop') stop();
    else if (step === 'keep') keep();
    else if (step === 'ask') confirmDiscard = true;
    return step === 'stop' || step === 'close';
  }

  /** Back from a question to the answer, with focus on its main button. */
  function keep() {
    confirmDiscard = confirmChanged = false;
    focusSoon(() => mainBtn);
  }

  // Closed any other way (the note closed, a note change): stop asking.
  onDestroy(() => asker.stop());

  $: items = action === 'checklist' ? checklistLines(result) : [];

  function apply(mode, anyway = false) {
    // The note changed while Trace worked (text added from elsewhere):
    // replacing it would drop that, so ask first.
    const replaces = action === 'checklist' || mode === 'replace';
    if (replaces && !anyway && body !== askedBody) { confirmChanged = true; return; }
    if (action === 'checklist') dispatch('checklist', { items });
    else if (action === 'summarize') dispatch(mode === 'replace' ? 'replace' : 'prepend', { markdown: result });
    else if (mode === 'append') dispatch('append', { markdown: result });
    else dispatch('replace', { markdown: result });
  }

  async function ask() {
    asking = true;
    await tick();
    instructionEl?.focus();
  }

  function onInstructionKey(e) {
    // Enter asks; Shift+Enter is a new line in the instruction. Not the Enter that
    // confirms a Japanese or Chinese conversion (Safari reports that one as 229).
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); run('custom'); }
  }
</script>

<div class="ta">
  {#if asking}
    <p class="ta-title">{$_('trace_actions.custom')}</p>
    <textarea class="input ta-instruction" dir="auto" rows="3" enterkeyhint="send" bind:this={instructionEl} bind:value={instruction}
      maxlength="2000" placeholder={$_('trace_actions.custom_placeholder')} aria-label={$_('trace_actions.custom')}
      on:keydown={onInstructionKey}></textarea>
    <div class="ta-buttons">
      <button class="btn btn-secondary" on:click={() => asking = false}>{$_('common.back')}</button>
      <button class="btn btn-primary" on:click={() => run('custom')} disabled={!instruction.trim()}>{$_('trace_actions.custom_go')}</button>
    </div>
  {:else if !action}
    <p class="ta-title">{$_('trace_actions.title')}</p>
    <button class="ta-row" on:click={() => run('tidy')}>
      <span class="material-symbols-rounded">auto_fix_high</span>
      <span><strong>{$_('trace_actions.tidy')}</strong><small>{$_('trace_actions.tidy_desc')}</small></span>
    </button>
    <button class="ta-row" on:click={() => run('expand')}>
      <span class="material-symbols-rounded">expand_content</span>
      <span><strong>{$_('trace_actions.expand')}</strong><small>{$_('trace_actions.expand_desc')}</small></span>
    </button>
    <button class="ta-row" on:click={() => run('summarize')}>
      <span class="material-symbols-rounded">short_text</span>
      <span><strong>{$_('trace_actions.summarize')}</strong><small>{$_('trace_actions.summarize_desc')}</small></span>
    </button>
    <button class="ta-row" on:click={() => run('checklist')}>
      <span class="material-symbols-rounded">checklist</span>
      <span><strong>{$_('trace_actions.checklist')}</strong><small>{$_('trace_actions.checklist_desc')}</small></span>
    </button>
    <button class="ta-row" on:click={ask}>
      <span class="material-symbols-rounded">edit_note</span>
      <span><strong>{$_('trace_actions.custom')}</strong><small>{$_('trace_actions.custom_desc')}</small></span>
    </button>
  {:else}
    <p class="ta-title">{$_(`trace_actions.${action}`)}</p>
    {#if action === 'custom'}<p class="ta-asked" dir="auto">{instruction.trim()}</p>{/if}
    {#if busy}
      <p class="ta-status" aria-live="polite"><span class="material-symbols-rounded spin">progress_activity</span>{$_('trace_actions.working')}</p>
      <div class="ta-buttons">
        <button class="btn btn-secondary" on:click={() => { stop(); dispatch('close'); }}>{$_('common.cancel')}</button>
      </div>
    {:else if error}
      <p class="ta-error" role="alert">{error}</p>
      <div class="ta-buttons">
        <button class="btn btn-secondary" on:click={() => { if (action === 'custom') asking = true; action = null; }}>{$_('common.back')}</button>
        <button class="btn btn-primary" bind:this={mainBtn} on:click={() => run(action)}>{$_('trace_actions.try_again')}</button>
      </div>
    {:else}
      <div class="ta-result">
        {#if action === 'checklist'}
          <ul>{#each items as it}<li><span class="box"></span>{it}</li>{/each}</ul>
        {:else}
          <p>{markdownToPreview(result, 4000)}</p>
        {/if}
      </div>
      {#if confirmDiscard}
        <div class="ta-confirm" role="alertdialog" aria-label={$_('trace_actions.discard_question')}>
          <p>{$_('trace_actions.discard_question')}</p>
          <div class="ta-buttons">
            <button class="btn btn-secondary" bind:this={keepBtn} on:click={keep}>{$_('trace_actions.keep')}</button>
            <button class="btn btn-danger" on:click={() => dispatch('close')}>{$_('trace_actions.discard')}</button>
          </div>
        </div>
      {:else if confirmChanged}
        <div class="ta-confirm" role="alertdialog" aria-label={$_('trace_actions.changed_question')}>
          <p>{$_('trace_actions.changed_question')}</p>
          <div class="ta-buttons">
            <button class="btn btn-secondary" bind:this={changedBtn} on:click={keep}>{$_('trace_actions.keep')}</button>
            {#if action !== 'checklist'}
              <button class="btn btn-secondary" on:click={() => apply('append')}>{$_('trace_actions.add_below')}</button>
            {/if}
            <button class="btn btn-danger" on:click={() => apply('replace', true)}>{$_('trace_actions.replace_anyway')}</button>
          </div>
        </div>
      {:else}
        <div class="ta-buttons">
          {#if action === 'custom'}
            <!-- Back to the instruction, kept, to change it. -->
            <button class="btn btn-secondary" on:click={() => { asking = true; action = null; tick().then(() => instructionEl?.focus()); }}>{$_('common.back')}</button>
          {:else}
            <button class="btn btn-secondary" on:click={() => dispatch('close')}>{$_('common.cancel')}</button>
          {/if}
          <button class="btn btn-secondary" on:click={() => run(action)}>{$_('trace_actions.try_again')}</button>
          {#if action === 'summarize'}
            <button class="btn btn-primary" bind:this={mainBtn} on:click={() => apply('prepend')}>{$_('trace_actions.add_to_top')}</button>
          {:else if action === 'custom'}
            <!-- An email or a reply made from the note goes under it; a changed note replaces it. -->
            <button class="btn btn-secondary" on:click={() => apply('append')}>{$_('trace_actions.add_below')}</button>
            <button class="btn btn-primary" bind:this={mainBtn} on:click={() => apply('replace')}>{$_('trace_actions.use_this')}</button>
          {:else}
            <button class="btn btn-primary" bind:this={mainBtn} on:click={() => apply('replace')} disabled={action === 'checklist' && !items.length}>
              {action === 'checklist' ? $_('trace_actions.use_checklist') : $_('trace_actions.use_this')}
            </button>
          {/if}
        </div>
        <p class="ta-hint">{$_('trace_actions.history_hint')}</p>
      {/if}
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
    max-height: 45dvh; overflow: auto; padding: 10px 12px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-md);
    font-size: 14px; line-height: 1.5; color: var(--text-1); white-space: pre-line;
  }
  .ta-result ul { list-style: none; display: flex; flex-direction: column; gap: 6px; white-space: normal; }
  .ta-result li { display: flex; gap: 8px; align-items: flex-start; }
  .box { width: 14px; height: 14px; margin-top: 3px; border: 1.5px solid var(--text-3); border-radius: 4px; flex-shrink: 0; }
  .ta-buttons { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
  .ta-buttons .btn { height: 38px; }
  .ta-hint { font-size: 11px; color: var(--text-3); text-align: right; }
  .ta-instruction { width: 100%; resize: vertical; min-height: 72px; font: inherit; font-size: 14px; }
  .ta-confirm { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); }
  .ta-confirm p { font-size: 14px; color: var(--text-1); }
  .ta-asked { margin-top: -4px; font-size: 13px; color: var(--text-2); overflow-wrap: anywhere; white-space: pre-line; }
</style>
