<script>
  /** NoteRow: one note in the List layout. */
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { labelsById } from '../../stores/notes.js';
  import { markdownToPreview } from '../../lib/note-preview.js';
  import { noteColorStyle, colorDot } from '../../lib/note-colors.js';
  import { relativeTime } from '../../lib/relative-time.js';
  import { longpress } from '../../lib/long-press.js';
  import { isAudio, isImage } from '../../lib/ai-extract.js';

  export let note;
  export let current = false;    // open in the side pane
  export let selected = false;   // multi-select
  export let selecting = false;

  const dispatch = createEventDispatcher();
  $: items = note.items || [];
  $: done = items.filter(i => i.checked).length;
  $: preview = note.kind === 'text' ? markdownToPreview(note.body_md, 160) : items.filter(i => !i.checked).slice(0, 4).map(i => i.text).join(' · ');
  $: firstLine = !note.title && note.kind === 'text' ? preview : '';
  $: noteLabels = (note.labels || []).map(id => $labelsById.get(id)).filter(Boolean).slice(0, 3);
  $: hasImages = (note.attachments || []).some(isImage);
  $: hasVoice = (note.attachments || []).some(isAudio);

  function click(e) {
    if (selecting || e.ctrlKey || e.metaKey) { dispatch('select', { note, range: e.shiftKey }); return; }
    dispatch('open', note);
  }
</script>

<div class="note-row" class:current class:selected class:colored={!!note.color}
  data-note-id={note.id} style={noteColorStyle(note.color)} tabindex="0" role="button"
  aria-current={current ? 'true' : undefined} aria-pressed={selecting ? selected : undefined}
  on:click={click} on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), click(e))}
  use:longpress on:longpress={() => dispatch('select', { note, range: false })}>
  <span class="strip" aria-hidden="true"></span>
  <div class="row-main">
    <div class="row-top">
      {#if note.pinned}<span class="material-symbols-rounded fill pin" aria-label={$_('notes.pinned')}>keep</span>{/if}
      <span class="row-title" class:untitled={!note.title}>{note.title || firstLine || $_('notes.untitled')}</span>
      <span class="row-date">{relativeTime(note.updated_at)}</span>
    </div>
    {#if preview && !firstLine}<p class="row-preview">{preview}</p>{/if}
    <div class="row-meta">
      {#if note.kind === 'checklist' && items.length}
        <span class="meta"><span class="material-symbols-rounded">checklist</span>{done}/{items.length}</span>
      {/if}
      {#if note.reminder_at}<span class="meta"><span class="material-symbols-rounded">notifications</span></span>{/if}
      {#if hasImages}<span class="meta"><span class="material-symbols-rounded">image</span></span>{/if}
      {#if hasVoice}<span class="meta"><span class="material-symbols-rounded">mic</span></span>{/if}
      {#if (note.share_count || 0) > 0 || (note.share_role && note.share_role !== 'owner')}<span class="meta"><span class="material-symbols-rounded">group</span></span>{/if}
      {#each noteLabels as l (l.id)}
        <span class="row-label"><span class="dot" style="background:{colorDot(l.color)}"></span>{l.name}</span>
      {/each}
    </div>
  </div>
  {#if selected}<span class="material-symbols-rounded fill row-check">check_circle</span>{/if}
</div>

<style>
  .note-row {
    position: relative; display: flex; gap: 0; cursor: pointer;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--note-bg) 70%, transparent);
    border: 1px solid transparent;
    transition: background 160ms ease, border-color 160ms ease, transform 120ms ease;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    outline: none;
  }
  .note-row:hover { background: var(--note-bg); border-color: var(--note-border); }
  .note-row:focus-visible { border-color: var(--accent); }
  .note-row.current {
    background: var(--note-bg);
    border-color: color-mix(in srgb, var(--accent) 55%, var(--note-border));
    box-shadow: 0 0 0 3px var(--accent-dim);
  }
  .note-row.selected { border-color: var(--accent); }
  .note-row:active { transform: scale(0.995); }
  .strip { width: 4px; border-radius: 4px; margin: 10px 0 10px 6px; background: transparent; flex-shrink: 0; }
  .note-row.colored .strip { background: var(--note-glow); }
  .row-main { flex: 1; min-width: 0; padding: 10px 12px 10px 10px; display: flex; flex-direction: column; gap: 3px; }
  .row-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .pin { font-size: 15px; color: var(--accent); }
  .row-title { flex: 1; min-width: 0; font-family: var(--font-note-title); font-size: 16px; font-weight: 500; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-title.untitled { font-family: inherit; font-size: 14px; }
  .row-date { flex-shrink: 0; font-size: 11px; color: var(--text-3); }
  .row-preview { font-size: 13px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-meta { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; }
  .row-meta:empty { display: none; }
  .meta { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--text-3); flex-shrink: 0; }
  .meta .material-symbols-rounded { font-size: 14px; }
  .row-label { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-3); white-space: nowrap; }
  .dot { width: 6px; height: 6px; border-radius: 50%; }
  .row-check { position: absolute; top: 8px; right: 8px; color: var(--accent); font-size: 20px; }
  .fill { font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
</style>
