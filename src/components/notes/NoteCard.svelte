<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { labelsById } from '../../stores/notes.js';
  import { markdownToPreview } from '../../lib/note-preview.js';
  import { noteColorStyle, colorDot } from '../../lib/note-colors.js';
  import { longpress } from '../../lib/long-press.js';
  import ReminderChip from './ReminderChip.svelte';
  import AttachmentGrid from './AttachmentGrid.svelte';
  import { isAudio, isImage } from '../../lib/ai-extract.js';
  import { formatDuration } from '../../lib/voice-recorder.js';
  import { isOwner, canEdit, isShared } from '../../lib/note-sharing.js';

  export let note;
  /** 'notes' | 'archive' | 'trash' controls which quick actions show. */
  export let view = 'notes';
  /** Position in the list, for the staggered entrance. */
  export let index = 0;
  /** Multi-select: this card is selected / some card is selected. */
  export let selected = false;
  export let selecting = false;

  const dispatch = createEventDispatcher();
  const PREVIEW_ITEMS = 8;

  $: preview = note.kind === 'text' ? markdownToPreview(note.body_md) : '';
  $: openItems = (note.items || []).filter(i => !i.checked);
  $: checkedCount = (note.items || []).length - openItems.length;
  $: totalItems = (note.items || []).length;
  $: progress = totalItems ? checkedCount / totalItems : 0;
  $: shownItems = openItems.slice(0, PREVIEW_ITEMS);
  $: hiddenOpen = openItems.length - shownItems.length;
  $: noteLabels = (note.labels || []).map(id => $labelsById.get(id)).filter(Boolean);
  $: images = (note.attachments || []).filter(isImage);
  $: voice = (note.attachments || []).filter(isAudio);
  $: empty = !note.title && !preview && !(note.items || []).length && !images.length && !voice.length;
  $: owner = isOwner(note);
  $: editable = canEdit(note);
  $: shared = isShared(note);

  function open(e) {
    // While selecting, or with Ctrl/Cmd held, a click selects instead of opening.
    if (selecting || e?.ctrlKey || e?.metaKey) { dispatch('select', { note, range: !!e?.shiftKey }); return; }
    dispatch('open', note);
  }
  function selectToggle(e) {
    e.stopPropagation();
    dispatch('select', { note, range: !!e.shiftKey });
  }

  // A soft light follows the pointer on devices that hover. Set as CSS
  // variables straight on the element, so it never re-renders the card.
  function spotlight(e) {
    if (e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
  }
  function onKey(e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
  }
  function act(e, action) {
    e.stopPropagation();
    dispatch('action', { note, action });
  }
  function toggleItem(e, item) {
    e.stopPropagation();
    if (view === 'trash' || !editable) return;
    dispatch('toggleItem', { note, item });
  }
</script>

<div
  class="note-card"
  class:note-card-empty={empty}
  class:colored={!!note.color}
  class:is-pinned={note.pinned && (view === 'notes' || view === 'reminders')}
  class:selected
  class:selecting
  aria-pressed={selecting ? selected : undefined}
  style="{noteColorStyle(note.color)} --i:{Math.min(index, 18)}"
  on:pointermove={spotlight}
  tabindex="0"
  role="button"
  aria-label={note.title || $_('notes.untitled')}
  on:click={open}
  on:keydown={onKey}
  use:longpress
  on:longpress={() => dispatch('select', { note, range: false })}
>
  <button class="card-select" class:on={selected} on:click={selectToggle}
    title={selected ? $_('select.deselect') : $_('select.select')} aria-label={selected ? $_('select.deselect') : $_('select.select')}>
    <span class="material-symbols-rounded" class:fill={selected}>{selected ? 'check_circle' : 'radio_button_unchecked'}</span>
  </button>
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

  {#if images.length}
    <AttachmentGrid attachments={images} size="card" />
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
          <button class="card-check" aria-label={$_('notes.check_item')} disabled={!editable} on:click={(e) => toggleItem(e, item)}></button>
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

  {#if note.kind === 'checklist' && totalItems > 1 && checkedCount > 0}
    <div class="card-progress" role="progressbar" aria-valuemin="0" aria-valuemax={totalItems} aria-valuenow={checkedCount}
      aria-label={$_('notes.checked_items', { values: { count: checkedCount } })}>
      <span style="width:{Math.round(progress * 100)}%"></span>
    </div>
  {/if}
  {#if noteLabels.length || note.reminder_at || shared || voice.length}
    <div class="card-chips">
      {#if voice.length}
        <span class="chip"><span class="material-symbols-rounded chip-icon">mic</span>{voice.length > 1 ? `${voice.length} · ` : ''}{formatDuration(voice.reduce((t, a) => t + (a.duration_ms || 0), 0))}</span>
      {/if}
      {#if shared}
        <span class="chip" title={owner ? $_('sharing.shared_with', { values: { count: note.share_count } }) : $_('sharing.shared_by', { values: { name: note.share_owner || '' } })}>
          <span class="material-symbols-rounded chip-icon">group</span>{owner ? note.share_count : (note.share_owner || '')}
        </span>
      {/if}
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
      {#if owner}
        <button class="card-act" title={$_('reminders.remind_me')} aria-label={$_('reminders.remind_me')} on:click={(e) => act(e, 'reminder')}>
          <span class="material-symbols-rounded">notification_add</span>
        </button>
      {/if}
      {#if editable}
        <button class="card-act" title={$_('notes.color')} aria-label={$_('notes.color')} on:click={(e) => act(e, 'color')}>
          <span class="material-symbols-rounded">palette</span>
        </button>
      {/if}
      <button class="card-act" title={view === 'archive' ? $_('notes.unarchive') : $_('notes.archive')}
        aria-label={view === 'archive' ? $_('notes.unarchive') : $_('notes.archive')}
        on:click={(e) => act(e, view === 'archive' ? 'unarchive' : 'archive')}>
        <span class="material-symbols-rounded">{view === 'archive' ? 'unarchive' : 'archive'}</span>
      </button>
      {#if owner}
        <button class="card-act" title={$_('notes.move_to_trash')} aria-label={$_('notes.move_to_trash')} on:click={(e) => act(e, 'trash')}>
          <span class="material-symbols-rounded">delete</span>
        </button>
      {/if}
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
    background:
      linear-gradient(165deg, var(--card-sheen) 0%, transparent 42%),
      var(--note-bg);
    box-shadow: var(--card-rest-shadow);
    color: var(--text-1);
    cursor: pointer;
    text-align: left;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    isolation: isolate;
    transition:
      transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1),
      box-shadow 260ms cubic-bezier(0.2, 0.8, 0.2, 1),
      border-color 200ms ease;
    animation: card-in 420ms cubic-bezier(0.2, 0.8, 0.2, 1) backwards;
    animation-delay: calc(var(--i, 0) * 28ms);
  }
  @keyframes card-in {
    from { opacity: 0; transform: translateY(10px) scale(0.985); }
    to   { opacity: 1; transform: none; }
  }
  /* Colored notes carry a thin glow of their color along the top edge. */
  .note-card::before {
    content: '';
    position: absolute; left: 14px; right: 14px; top: -1px; height: 2px;
    border-radius: 2px;
    background: linear-gradient(90deg, transparent, var(--note-glow), transparent);
    opacity: 0;
    transition: opacity 260ms ease;
    pointer-events: none;
  }
  .note-card.colored::before { opacity: 0.45; }
  .note-card.is-pinned { border-color: color-mix(in srgb, var(--accent) 30%, var(--note-border)); }
  /* Pointer spotlight, tinted with the note's color. */
  .note-card::after {
    content: '';
    position: absolute; inset: 0;
    border-radius: inherit;
    background: radial-gradient(260px circle at var(--mx, 50%) var(--my, 0%), color-mix(in srgb, var(--note-glow) 14%, transparent), transparent 70%);
    opacity: 0;
    transition: opacity 260ms ease;
    pointer-events: none;
    z-index: -1;
  }
  @media (hover: hover) {
    .note-card:hover {
      transform: translateY(-4px);
      border-color: color-mix(in srgb, var(--note-glow) 45%, var(--note-border));
      box-shadow:
        var(--card-lift-shadow),
        0 10px 30px -18px color-mix(in srgb, var(--note-glow) 70%, transparent);
    }
    .note-card:hover::before { opacity: 0.9; }
    .note-card:hover::after { opacity: 1; }
    .note-card:hover :global(.grid img) { transform: scale(1.035); }
  }
  .note-card :global(.grid img) { transition: transform 420ms cubic-bezier(0.2, 0.8, 0.2, 1); }
  .note-card:active { transform: translateY(-1px) scale(0.99); transition-duration: 120ms; }
  @media (prefers-reduced-motion: reduce) {
    .note-card { animation: none; transition: box-shadow 160ms ease, border-color 160ms ease; }
    .note-card:hover, .note-card:active { transform: none; }
    .note-card:hover :global(.grid img) { transform: none; }
  }
  :global(html.no-animations) .note-card { animation: none; }
  :global(html.no-animations) .note-card:hover,
  :global(html.no-animations) .note-card:active { transform: none; }

  /* Multi-select */
  .card-select {
    position: absolute; top: -10px; left: -10px; z-index: 2;
    width: 28px; height: 28px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: var(--surface-1); color: var(--text-2);
    box-shadow: var(--shadow-sm);
    opacity: 0; transform: scale(0.8);
    transition: opacity 160ms ease, transform 160ms ease, color 120ms ease;
  }
  .card-select .material-symbols-rounded { font-size: 24px; }
  .card-select.on { color: var(--accent); opacity: 1; transform: none; }
  .note-card.selecting .card-select { opacity: 1; transform: none; }
  @media (hover: hover) {
    .note-card:hover .card-select { opacity: 1; transform: none; }
  }
  .note-card.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent), var(--card-rest-shadow);
  }
  .note-card.selecting .card-pin, .note-card.selecting .card-actions { visibility: hidden; }

  .card-progress {
    height: 3px; border-radius: 3px; overflow: hidden;
    background: color-mix(in srgb, var(--text-1) 9%, transparent);
    margin-top: -2px;
  }
  .card-progress span {
    display: block; height: 100%; border-radius: inherit;
    background: linear-gradient(90deg, color-mix(in srgb, var(--note-glow) 70%, var(--accent)), var(--note-glow));
    transition: width 420ms cubic-bezier(0.2, 0.8, 0.2, 1);
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
  .chip-icon { font-size: 14px; margin-left: -2px; }
  .card-check:disabled { opacity: 0.5; cursor: default; }

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
