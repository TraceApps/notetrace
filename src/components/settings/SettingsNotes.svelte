<script>
  import Toggle from './Toggle.svelte';
  // Notes section: how notes behave (density, order, gestures, shortcuts,
  // link previews) and what Tasks gathers. Appearance keeps the app's look.
  import { _ } from 'svelte-i18n';
  import { linkPreviews, noteSort, labelOrder, keyboardShortcuts, cardDensity, swipeToArchive, tasksAllChecklists } from '../../stores/settings.js';
  import { linkPreviewsAvailable } from '../../lib/link-preview.js';
  import ShortcutsHelp from '../notes/ShortcutsHelp.svelte';
  import { noteTemplates } from '../../stores/settings.js';
  import { cleanTemplates, MAX_NAME } from '../../lib/note-templates.js';
  import { promptDialog } from '../../stores/confirmDialog.js';
  import { showUndo } from '../../stores/toast.js';

  $: templates = cleanTemplates($noteTemplates);

  async function renameTemplate(t) {
    const name = await promptDialog({
      title: $_('templates.rename_title'), value: t.name, maxlength: MAX_NAME,
      placeholder: $_('templates.name_placeholder'), confirmText: $_('common.save'), cancelText: $_('common.cancel'),
    });
    if (!name || name === t.name) return;
    noteTemplates.set(cleanTemplates($noteTemplates).map(x => x.id === t.id ? { ...x, name } : x));
  }
  function deleteTemplate(t) {
    const before = cleanTemplates($noteTemplates);
    noteTemplates.set(before.filter(x => x.id !== t.id));
    showUndo($_('templates.deleted'), () => noteTemplates.set(before), $_('common.undo'));
  }

  let shortcutsOpen = false;
  const hasKeyboard = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.notes.density')}</span>
        <div class="setting-desc">{$_('settings_page.notes.density_desc')}</div>
      </div>
      <div class="select-wrap" style="width:160px">
        <select aria-label={$_('settings_page.notes.density')} class="select sel-sm" value={$cardDensity} on:change={e => cardDensity.set(e.target.value)}>
          <option value="comfortable">{$_('settings_page.notes.density_comfortable')}</option>
          <option value="compact">{$_('settings_page.notes.density_compact')}</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.notes.note_order')}</span>
        <div class="setting-desc">{$_('settings_page.notes.note_order_desc')}</div>
      </div>
      <div class="select-wrap" style="width:160px">
        <select aria-label={$_('settings_page.notes.note_order')} class="select sel-sm" value={$noteSort} on:change={e => noteSort.set(e.target.value)}>
          <option value="edited">{$_('settings_page.notes.note_order_edited')}</option>
          <option value="custom">{$_('settings_page.notes.note_order_custom')}</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.notes.label_order')}</span>
        <div class="setting-desc">{$_('settings_page.notes.label_order_desc')}</div>
      </div>
      <div class="select-wrap" style="width:160px">
        <select aria-label={$_('settings_page.notes.label_order')} class="select sel-sm" value={$labelOrder} on:change={e => labelOrder.set(e.target.value)}>
          <option value="alpha">{$_('settings_page.notes.label_order_alpha')}</option>
          <option value="used">{$_('settings_page.notes.label_order_used')}</option>
          <option value="custom">{$_('settings_page.notes.label_order_custom')}</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.notes.tasks_all')}</span>
        <div class="setting-desc">{$_('settings_page.notes.tasks_all_desc')}</div>
      </div>
      <Toggle label={$_('settings_page.notes.tasks_all')} checked={$tasksAllChecklists} on:change={e => tasksAllChecklists.set(e.detail)} />
    </div>
    {#if !hasKeyboard}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_page.notes.swipe')}</span>
          <div class="setting-desc">{$_('settings_page.notes.swipe_desc')}</div>
        </div>
        <Toggle label={$_('settings_page.notes.swipe')} checked={$swipeToArchive} on:change={e => swipeToArchive.set(e.detail)} />
      </div>
    {/if}
    {#if hasKeyboard}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_page.notes.shortcuts')}</span>
          <div class="setting-desc">{$_('settings_page.notes.shortcuts_desc')}</div>
        </div>
        <button class="btn btn-secondary" style="height:34px" on:click={() => shortcutsOpen = true}>{$_('settings_page.notes.shortcuts_view')}</button>
        <Toggle label={$_('settings_page.notes.shortcuts')} checked={$keyboardShortcuts} on:change={e => keyboardShortcuts.set(e.detail)} />
      </div>
    {/if}
    {#if linkPreviewsAvailable}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_page.notes.link_previews')}</span>
          <div class="setting-desc">{$_('settings_page.notes.link_previews_desc')}</div>
        </div>
        <Toggle label={$_('settings_page.notes.link_previews')} checked={$linkPreviews} on:change={e => linkPreviews.set(e.detail)} />
      </div>
    {/if}
  </div>

  <p class="settings-group-heading">{$_('templates.title')}</p>
  <div class="card settings-card">
    <p class="setting-desc templates-note">{$_('templates.desc')}</p>
    {#each templates as t (t.id)}
      <div class="setting-divider"></div>
      <div class="setting-row template-row">
        <span class="material-symbols-rounded template-icon" aria-hidden="true">{t.kind === 'checklist' ? 'checklist' : 'notes'}</span>
        <div class="template-text">
          <span class="setting-label">{t.name}</span>
          <div class="setting-desc">{t.kind === 'checklist' ? $_('templates.items', { values: { n: t.items.length } }) : $_('templates.text')}</div>
        </div>
        <button class="icon-btn" on:click={() => renameTemplate(t)} title={$_('templates.rename')} aria-label="{$_('templates.rename')}: {t.name}">
          <span class="material-symbols-rounded">edit</span>
        </button>
        <button class="icon-btn" on:click={() => deleteTemplate(t)} title={$_('templates.delete')} aria-label="{$_('templates.delete')}: {t.name}">
          <span class="material-symbols-rounded">delete</span>
        </button>
      </div>
    {:else}
      <div class="setting-divider"></div>
      <p class="setting-desc templates-note">{$_('templates.empty')}</p>
    {/each}
  </div>
</div>

<ShortcutsHelp bind:open={shortcutsOpen} />

<style>
  .section-body { display: flex; flex-direction: column; }
  .templates-note { margin: 4px 0; }
  .template-row { gap: 8px; }
  .template-icon { color: var(--text-3); font-size: 20px; flex-shrink: 0; }
  .template-text { flex: 1; min-width: 0; }
  .template-text .setting-label { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
