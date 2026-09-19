<script>
  import { renameNested, orderLabels } from '../../lib/label-tree.js';
  import { _ } from 'svelte-i18n';
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import { dragHandleZone, dragHandle, SHADOW_ITEM_MARKER_PROPERTY_NAME } from 'svelte-dnd-action';
  import { labelOrder, disableAnimations } from '../../stores/settings.js';
  import Sheet from '../ui/Sheet.svelte';
  import LabelStylePicker from './LabelStylePicker.svelte';
  import LabelGlyph from './LabelGlyph.svelte';
  import Popover from './Popover.svelte';
  import { NoteApi } from '../../lib/api.js';
  import { labels, refreshLabels, signalNotesChanged } from '../../stores/notes.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { showError } from '../../stores/toast.js';

  export let open = false;

  let newName = '';
  let drafts = {};
  let colorFor = null;
  let colorAnchor = null;
  let colorOpen = false;

  $: if (open) drafts = Object.fromEntries($labels.map(l => [l.id, l.name]));

  // Custom order: drag rows by the handle. Rows follow the labels store,
  // except while a drag and its save are under way.
  let rows = [];
  let holding = false;
  $: if (!holding) rows = $labels;
  $: custom = $labelOrder === 'custom';
  $: flipMs = $disableAnimations ? 0 : 220;

  // The row being dragged lifts off the list; the gap it leaves shows where it
  // will land; the row glows briefly once it settles.
  function lift(el) {
    el.classList.add('lm-lifted');
    if ($disableAnimations) el.classList.add('lm-still');
  }
  let settledId = null;
  let settledTimer;

  function onConsider(e) {
    holding = true;
    rows = e.detail.items;
  }
  async function onFinalize(e) {
    rows = e.detail.items;
    clearTimeout(settledTimer);
    settledId = e.detail.info?.id ?? null;
    settledTimer = setTimeout(() => { settledId = null; }, 900);
    // Nested labels stay with their parent: save the order as it will show.
    const ids = orderLabels(rows.map((l, i) => ({ ...l, position: i + 1 })), 'custom').map(l => l.id);
    try {
      await NoteApi.reorderLabels(ids);
      await refreshLabels();
    } catch (err) {
      showError(err.message);
    } finally {
      holding = false;
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    try {
      await NoteApi.createLabel({ name });
      newName = '';
      await refreshLabels();
    } catch (e) { showError(e.message); }
  }

  async function rename(l) {
    const name = (drafts[l.id] || '').trim();
    if (!name || name === l.name) { drafts[l.id] = l.name; return; }
    try {
      await NoteApi.updateLabel(l.id, { name });
      // Labels nested under this one ("Old/Child") follow the new name.
      for (const child of renameNested($labels, l.name, name)) {
        await NoteApi.updateLabel(child.id, { name: child.name }).catch(() => {});
      }
      await refreshLabels();
    } catch (e) {
      drafts[l.id] = l.name;
      showError(e.message);
    }
  }

  function pickColor(e, l) {
    colorFor = l;
    colorAnchor = e.currentTarget.getBoundingClientRect();
    colorOpen = true;
  }

  // The picker stays open, so color and icon can both be set.
  async function setStyle(patch) {
    const l = colorFor;
    if (!l) return;
    colorFor = { ...l, ...patch };
    try {
      await NoteApi.updateLabel(l.id, patch);
      await refreshLabels();
    } catch (e) { showError(e.message); }
  }

  async function remove(l) {
    const ok = await confirmDialog({
      title: $_('labels.delete_title'),
      message: $_('labels.delete_message', { values: { name: l.name } }),
      confirmText: $_('labels.delete'),
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NoteApi.deleteLabel(l.id);
      await refreshLabels();
      signalNotesChanged();
    } catch (e) { showError(e.message); }
  }
</script>

<Sheet bind:open title={$_('labels.edit_labels')}>
  <div class="lm">
    <div class="lm-row lm-new">
      <span class="material-symbols-rounded lm-lead">add</span>
      <input class="lm-input" placeholder={$_('labels.create_placeholder')} bind:value={newName}
        maxlength="60" on:keydown={(e) => e.key === 'Enter' && create()} />
      <button class="lm-icon" on:click={create} disabled={!newName.trim()} aria-label={$_('labels.create')}>
        <span class="material-symbols-rounded">check</span>
      </button>
    </div>
    <div class="lm-list" class:custom use:dragHandleZone={{ items: rows, flipDurationMs: flipMs, dropTargetStyle: {}, type: 'labels', dragDisabled: !custom, transformDraggedElement: lift, delayTouchStart: 60 }}
      on:consider={onConsider} on:finalize={onFinalize}>
    {#each rows as l (l.id)}
      <div class="lm-row" class:lm-shadow={l[SHADOW_ITEM_MARKER_PROPERTY_NAME]} class:lm-settled={settledId === l.id}
        animate:flip={{ duration: flipMs, easing: cubicOut }}>
        {#if custom}
          <span class="lm-handle" use:dragHandle aria-label={$_('labels.drag_to_reorder', { values: { name: l.name } })}>
            <span class="material-symbols-rounded">drag_indicator</span>
          </span>
        {/if}
        <button class="lm-dot-btn" on:click={(e) => pickColor(e, l)} title={$_('labels.style')} aria-label={$_('labels.style')}>
          <LabelGlyph label={l} size={12} iconSize={20} />
        </button>
        <input class="lm-input" bind:value={drafts[l.id]} maxlength="60"
          on:blur={() => rename(l)} on:keydown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
        <span class="lm-count">{l.note_count}</span>
        <button class="lm-icon" on:click={() => remove(l)} aria-label={$_('labels.delete')}>
          <span class="material-symbols-rounded">delete</span>
        </button>
      </div>
    {/each}
    </div>
    {#if !$labels.length}
      <p class="lm-empty">{$_('labels.empty')}</p>
    {:else}
      <p class="lm-order">{$_(custom ? 'labels.order_custom_hint' : $labelOrder === 'used' ? 'labels.order_used_hint' : 'labels.order_alpha_hint')}</p>
    {/if}
  </div>
</Sheet>

<Popover bind:open={colorOpen} anchor={colorAnchor} label={$_('labels.color_title')}>
  {#if colorFor}
    <LabelStylePicker color={colorFor.color} icon={colorFor.icon}
      on:color={(e) => setStyle({ color: e.detail })} on:icon={(e) => setStyle({ icon: e.detail })} />
  {/if}
</Popover>

<style>
  .lm { display: flex; flex-direction: column; gap: 2px; padding: 4px 0 12px; }
  .lm-row { display: flex; align-items: center; gap: 8px; min-height: 48px; }
  .lm-new { border-bottom: 1px solid var(--border); margin-bottom: 6px; }
  .lm-lead { width: 36px; text-align: center; color: var(--text-3); }
  .lm-input {
    flex: 1; min-width: 0; height: 40px; padding: 0 10px;
    background: none; border: 1px solid transparent; border-radius: 10px;
    color: var(--text-1); font-size: 15px; outline: none;
  }
  .lm-input:focus { border-color: var(--accent); background: var(--surface-2); }
  .lm-dot-btn { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border-radius: 10px; }
  .lm-dot-btn:hover { background: color-mix(in srgb, var(--text-1) 8%, transparent); }
  .lm-count { font-size: 12px; color: var(--text-3); min-width: 20px; text-align: right; }
  .lm-icon { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 10px; color: var(--text-2); }
  .lm-icon:hover:not(:disabled) { background: color-mix(in srgb, var(--text-1) 8%, transparent); color: var(--text-1); }
  .lm-icon:disabled { opacity: 0.35; }
  .lm-empty { color: var(--text-3); font-size: 14px; padding: 12px 8px; }
  .lm-list { display: flex; flex-direction: column; gap: 2px; }
  .lm-list .lm-row {
    border-radius: 14px; padding-right: 2px;
    transition: background-color 160ms ease, box-shadow 200ms ease;
  }
  .lm-list.custom .lm-row { padding-left: 2px; }
  @media (hover: hover) {
    .lm-list .lm-row:hover { background: color-mix(in srgb, var(--text-1) 4%, transparent); }
    .lm-list .lm-row:hover .lm-handle { color: var(--text-1); opacity: 1; }
  }
  .lm-handle {
    width: 28px; height: 40px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    color: var(--text-3); opacity: 0.7; border-radius: 10px; cursor: grab; touch-action: none;
    transition: color 160ms ease, opacity 160ms ease, background-color 160ms ease, transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .lm-handle .material-symbols-rounded { font-size: 20px; }
  .lm-handle:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent) !important; transform: scale(1.08); }
  .lm-handle:active { cursor: grabbing; transform: scale(0.94); }
  .lm-handle:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; opacity: 1; }

  /* The row in your hand: lifted, tilted a touch, with the accent edge. */
  .lm-row:global(.lm-lifted) {
    background: var(--surface-2) !important;
    box-shadow: 0 18px 40px -12px rgba(0, 0, 0, 0.55), 0 0 0 1.5px color-mix(in srgb, var(--accent) 70%, transparent);
    scale: 1.03; rotate: -0.6deg; cursor: grabbing;
    animation: lm-lift 180ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .lm-row:global(.lm-lifted) .lm-handle { color: var(--accent); opacity: 1; }
  .lm-row:global(.lm-lifted.lm-still) { animation: none; rotate: 0deg; }
  @keyframes lm-lift { from { scale: 1; rotate: 0deg; box-shadow: none; } }

  /* Where it will land: a soft accent slot. */
  .lm-row.lm-shadow {
    background: color-mix(in srgb, var(--accent) 9%, transparent);
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .lm-row.lm-shadow > * { visibility: hidden; }

  /* Just dropped: a brief glow that fades. */
  .lm-row.lm-settled { animation: lm-settle 900ms ease-out; }
  @keyframes lm-settle {
    0% { background: color-mix(in srgb, var(--accent) 20%, transparent); box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--accent) 55%, transparent); }
    100% { background: transparent; box-shadow: 0 0 0 1.5px transparent; }
  }
  @media (prefers-reduced-motion: reduce) {
    .lm-row.lm-settled, .lm-row:global(.lm-lifted) { animation: none; }
    .lm-handle { transition: none; }
  }
  .lm-order { color: var(--text-3); font-size: 12px; padding: 10px 8px 0; line-height: 1.4; }
</style>
