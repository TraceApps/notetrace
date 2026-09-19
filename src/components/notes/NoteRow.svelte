<script>
  /** NoteRow: one note in the List layout. Title, two lines of preview, when it was
   *  edited with its details, and a thumbnail of its first image. */
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { labelsById } from '../../stores/notes.js';
  import { markdownToPreview } from '../../lib/note-preview.js';
  import Highlight from './Highlight.svelte';
  import { noteColorStyle, colorDot } from '../../lib/note-colors.js';
  import { relativeTime } from '../../lib/relative-time.js';
  import { longpress } from '../../lib/long-press.js';
  import { isAudio, isImage } from '../../lib/ai-extract.js';
  import { isFile } from '../../lib/file-kinds.js';
  import { resolveAssetUrl } from '../../lib/platform.js';

  export let note;
  export let current = false;    // open in the reading pane
  export let selected = false;   // multi-select
  export let selecting = false;
  export let terms = [];

  const dispatch = createEventDispatcher();
  $: items = note.items || [];
  $: done = items.filter(i => i.checked).length;
  $: preview = note.kind === 'text' ? markdownToPreview(note.body_md, 220) : items.filter(i => !i.checked).slice(0, 6).map(i => i.text).join(' · ');
  $: firstLine = !note.title && note.kind === 'text' ? preview : '';
  $: noteLabels = (note.labels || []).map(id => $labelsById.get(id)).filter(Boolean).slice(0, 3);
  $: thumb = (note.attachments || []).find(isImage);
  $: hasVoice = (note.attachments || []).some(isAudio);
  $: fileCount = (note.attachments || []).filter(isFile).length;
  $: shared = (note.share_count || 0) > 0 || (note.share_role && note.share_role !== 'owner');
  let thumbFailed = false;
  $: thumb, thumbFailed = false;

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
      <span class="row-title" class:untitled={!note.title}><Highlight text={note.title || firstLine || $_('notes.untitled')} {terms} /></span>
      {#if selecting}
        <span class="material-symbols-rounded row-check" class:fill={selected} aria-hidden="true">{selected ? 'check_circle' : 'radio_button_unchecked'}</span>
      {/if}
    </div>
    {#if preview && !firstLine}<p class="row-preview"><Highlight text={preview} {terms} /></p>{/if}
    <div class="row-meta">
      <span class="row-date">{relativeTime(note.updated_at)}</span>
      {#if note.kind === 'checklist' && items.length}
        <span class="meta"><span class="material-symbols-rounded">checklist</span>{done}/{items.length}</span>
      {/if}
      {#if note.reminder_at}<span class="meta"><span class="material-symbols-rounded">notifications</span></span>{/if}
      {#if hasVoice}<span class="meta"><span class="material-symbols-rounded">mic</span></span>{/if}
      {#if fileCount}<span class="meta"><span class="material-symbols-rounded">attach_file</span>{fileCount > 1 ? fileCount : ''}</span>{/if}
      {#if shared}<span class="meta"><span class="material-symbols-rounded">group</span></span>{/if}
      {#each noteLabels as l (l.id)}
        <span class="row-label"><span class="dot" style="background:{colorDot(l.color)}"></span>{l.name}</span>
      {/each}
    </div>
  </div>
  {#if thumb && !thumbFailed}
    <img class="thumb" src={resolveAssetUrl(thumb.url)} alt="" loading="lazy" draggable="false" on:error={() => thumbFailed = true} />
  {/if}
  {#if current}<span class="current-bar" aria-hidden="true"></span>{/if}
</div>

<style>
  .note-row {
    position: relative; display: flex; align-items: flex-start; gap: 12px; cursor: pointer;
    padding: 13px 16px 13px 18px;
    background: transparent;
    transition: background 160ms ease;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    outline: none;
  }
  /* Rows are separated by hairlines, not boxes. */
  .note-row::after {
    content: ''; position: absolute; left: 18px; right: 16px; bottom: 0; height: 1px;
    background: var(--border); pointer-events: none;
  }
  .note-row:last-child::after { display: none; }
  .note-row.colored { background: color-mix(in srgb, var(--note-bg) 45%, transparent); }
  .note-row:hover { background: color-mix(in srgb, var(--text-1) 5%, transparent); }
  .note-row.colored:hover { background: color-mix(in srgb, var(--note-bg) 80%, transparent); }
  .note-row:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
  .note-row.current, .note-row.current:hover {
    background: var(--accent-dim);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .note-row.current::after { display: none; }
  .note-row.selected { background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .strip { position: absolute; left: 6px; top: 14px; bottom: 14px; width: 3px; border-radius: 3px; background: transparent; }
  .note-row.colored .strip { background: var(--note-glow); }
  .current-bar { position: absolute; right: 0; top: 50%; width: 4px; height: 24px; transform: translateY(-50%); border-radius: 4px 0 0 4px; background: var(--accent); }

  .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .row-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .pin { font-size: 15px; color: var(--accent); }
  .row-title { flex: 1; min-width: 0; font-family: var(--font-note-title); font-size: 16.5px; font-weight: 500; line-height: 1.3; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .current .row-title { color: var(--accent); }
  .row-title.untitled { font-family: inherit; font-size: 14px; }
  .row-preview {
    font-size: 13px; line-height: 1.45; color: var(--text-2);
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    overflow-wrap: anywhere;
  }
  .row-meta { display: flex; align-items: center; gap: 9px; min-width: 0; overflow: hidden; margin-top: 2px; }
  .row-date { flex-shrink: 0; font-size: 11.5px; color: var(--text-3); }
  .meta { display: inline-flex; align-items: center; gap: 3px; font-size: 11.5px; color: var(--text-3); flex-shrink: 0; }
  .meta .material-symbols-rounded { font-size: 14px; }
  .row-label { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--text-3); white-space: nowrap; }
  .dot { width: 6px; height: 6px; border-radius: 50%; }
  .thumb { width: 60px; height: 60px; flex-shrink: 0; object-fit: cover; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2); }
  .row-check { font-size: 20px; color: var(--text-3); flex-shrink: 0; }
  .selected .row-check { color: var(--accent); }
  .fill { font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
</style>
