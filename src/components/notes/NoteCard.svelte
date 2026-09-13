<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { labelsById } from '../../stores/notes.js';
  import { markdownToPreview } from '../../lib/note-preview.js';
  import { noteColorStyle, colorDot } from '../../lib/note-colors.js';
  import { longpress } from '../../lib/long-press.js';
  import ReminderChip from './ReminderChip.svelte';

  export let note;
  /** 'notes' | 'archive' | 'trash' controls which quick actions show. */
  export let view = 'notes';

  const dispatch = createEventDispatcher();
  const PREVIEW_ITEMS = 8;

  $: preview = note.kind === 'text' ? markdownToPreview(note.body_md) : '';
  $: openItems = (note.items || []).filter(i => !i.checked);
  $: checkedCount = (note.items || []).length - openItems.length;
  $: shownItems = openItems.slice(0, PREVIEW_ITEMS);
  $: hiddenOpen = openItems.length - shownItems.length;
  $: noteLabels = (note.labels || []).map(id => $labelsById.get(id)).filter(Boolean);
  $: empty = !note.title && !preview && !(note.items || []).length;

  function open() { dispatch('open', note); }
  function onKey(e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  }
  function act(e, action) {
    e.stopPropagation();
    dispatch('action', { note, action });
  }
  function toggleItem(e, item) {
    e.stopPropagation();
    if (view === 'trash') return;
    dispatch('toggleItem', { note, item });
  }
</script>

<div
  class="note-card"
  class:note-card-empty={empty}
  style={noteColorStyle(note.color)}
  tabindex="0"
  role="button"
  aria-label={note.title || $_('notes.untitled')}
  on:click={open}
  on:keydown={onKey}
  use:longpress
  on:longpress={(e) => dispatch('menu', { note, x: e.detail.x, y: e.detail.y })}
>
  {#if view === 'notes' || view === 'reminders'}
    <button
      class="card-pin"
      class:pinned={note.pinned}
      title={note.pinned ? $_('notes.unpin') : $_('notes.pin')}
      aria-label={note.pinned ? $_('notes.unpin') : $_('notes.pin')}
      on:click={(e) => act(e, 'pin')}
    >
      <span class="material-symbols-rounded" class:fill={note.pinned}>keep</span>
    </button>
  {/if}

  {#if note.title}
    <h3 class="card-title">{note.title}</h3>
  {/if}

  {#if note.kind === 'text'}
    {#if preview}<p class="card-body">{preview}</p>{/if}
  {:else}
    <ul class="card-items">
      {#each shownItems as item (item.uuid)}
        <li>
          <button class="card-check" aria-label={$_('notes.check_item')} on:click={(e) => toggleItem(e, item)}></button>
          <span class="card-item-text">{item.text}</span>
        </li>
      {/each}
      {#if hiddenOpen > 0}
        <li class="card-more">{$_('notes.more_items', { values: { count: hiddenOpen } })}</li>
      {/if}
      {#if checkedCount > 0}
        <li class="card-more">
          <span class="material-symbols-rounded">check</span>
          {$_('notes.checked_items', { values: { count: checkedCount } })}
        </li>
      {/if}
    </ul>
  {/if}

  {#if empty}
    <p class="card-body card-placeholder">{$_('notes.empty_note')}</p>
  {/if}

  {#if noteLabels.length || note.reminder_at}
    <div class="card-chips">
      {#if note.reminder_at}<ReminderChip {note} />{/if}
      {#each noteLabels as l (l.id)}
        <span class="chip"><span class="chip-dot" style="background:{colorDot(l.color)}"></span>{l.name}</span>
      {/each}
    </div>
  {/if}

  <div class="card-actions">
    {#if view === 'trash'}
      <button class="card-act" title={$_('notes.restore')} aria-label={$_('notes.restore')} on:click={(e) => act(e, 'restore')}>
        <span class="material-symbols-rounded">restore_from_trash</span>
      </button>
      <button class="card-act" title={$_('notes.delete_forever')} aria-label={$_('notes.delete_forever')} on:click={(e) => act(e, 'deleteForever')}>
        <span class="material-symbols-rounded">delete_forever</span>
      </button>
    {:else}
      <button class="card-act" title={$_('reminders.remind_me')} aria-label={$_('reminders.remind_me')} on:click={(e) => act(e, 'reminder')}>
        <span class="material-symbols-rounded">notification_add</span>
      </button>
      <button class="card-act" title={$_('notes.color')} aria-label={$_('notes.color')} on:click={(e) => act(e, 'color')}>
        <span class="material-symbols-rounded">palette</span>
      </button>
      <button class="card-act" title={view === 'archive' ? $_('notes.unarchive') : $_('notes.archive')}
        aria-label={view === 'archive' ? $_('notes.unarchive') : $_('notes.archive')}
        on:click={(e) => act(e, view === 'archive' ? 'unarchive' : 'archive')}>
        <span class="material-symbols-rounded">{view === 'archive' ? 'unarchive' : 'archive'}</span>
      </button>
      <button class="card-act" title={$_('notes.move_to_trash')} aria-label={$_('notes.move_to_trash')} on:click={(e) => act(e, 'trash')}>
        <span class="material-symbols-rounded">delete</span>
      </button>
    {/if}
  </div>
</div>

<style>
  .note-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 18px 12px;
    background: var(--note-bg);
    border: 1px solid var(--note-border);
    border-radius: var(--radius-lg);
    color: var(--text-1);
    cursor: pointer;
    text-align: left;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    transition: box-shadow var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), border-color var(--dur-fast);
  }
  @media (hover: hover) {
    .note-card:hover { box-shadow: var(--shadow-md); border-color: var(--border-strong); }
  }
  .note-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .card-title {
    font-family: var(--font-note-title);
    font-weight: 500;
    font-size: 19px;
    line-height: 1.25;
    letter-spacing: -0.005em;
    padding-right: 26px;
    overflow-wrap: anywhere;
  }
  .card-body {
    font-size: 14px;
    line-height: 1.55;
    color: color-mix(in srgb, var(--text-1) 82%, transparent);
    white-space: pre-line;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 14;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .note-card:not(:has(.card-title)) .card-body { padding-right: 26px; }
  .card-placeholder { color: var(--text-3); font-style: italic; }

  .card-items { list-style: none; display: flex; flex-direction: column; gap: 7px; }
  .card-items li { display: flex; align-items: flex-start; gap: 10px; font-size: 14px; line-height: 1.4; color: color-mix(in srgb, var(--text-1) 82%, transparent); }
  .card-item-text { overflow-wrap: anywhere; }
  .card-check {
    width: 16px; height: 16px; margin-top: 1px; flex-shrink: 0;
    border-radius: 5px;
    border: 1.5px solid var(--text-3);
  }
  .card-check:hover { border-color: var(--accent); }
  .card-more { color: var(--text-3) !important; font-size: 13px !important; align-items: center !important; gap: 6px !important; }
  .card-more .material-symbols-rounded { font-size: 16px; }

  .card-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    height: 24px; display: inline-flex; align-items: center; gap: 6px; padding: 0 9px;
    border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--text-1) 7%, transparent);
    font-size: 11px; font-weight: 500; color: var(--text-2);
    max-width: 100%;
  }
  .chip-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

  .card-pin, .card-act {
    display: flex; align-items: center; justify-content: center;
    color: var(--text-2);
    border-radius: 10px;
  }
  .card-pin {
    position: absolute; top: 8px; right: 8px;
    width: 34px; height: 34px;
    opacity: 0;
    transition: opacity var(--dur-fast);
  }
  .card-pin.pinned { opacity: 1; color: var(--accent); }
  .card-pin .material-symbols-rounded { font-size: 20px; }
  .fill { font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24; }

  .card-actions {
    display: flex; gap: 2px; margin: 0 -8px -4px;
    opacity: 0;
    transition: opacity var(--dur-fast);
  }
  .card-act { width: 34px; height: 34px; }
  .card-act .material-symbols-rounded { font-size: 19px; }
  .card-pin:hover, .card-act:hover { background: color-mix(in srgb, var(--text-1) 9%, transparent); color: var(--text-1); }

  @media (hover: hover) {
    .note-card:hover .card-pin, .note-card:focus-within .card-pin,
    .note-card:hover .card-actions, .note-card:focus-within .card-actions { opacity: 1; }
  }
  /* Touch screens have no hover: actions live in the long-press menu, so
     the action row collapses instead of reserving empty space. */
  @media (hover: none) {
    .card-actions { display: none; }
    .card-pin:not(.pinned) { display: none; }
  }
</style>
