<script>
  import { renameNested } from '../../lib/label-tree.js';
  import { _ } from 'svelte-i18n';
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
    {#each $labels as l (l.id)}
      <div class="lm-row">
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
    {#if !$labels.length}
      <p class="lm-empty">{$_('labels.empty')}</p>
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
</style>
