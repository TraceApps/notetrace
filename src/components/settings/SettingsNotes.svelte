<script>
  // Notes section: how notes behave (density, order, gestures, shortcuts,
  // link previews) and what Tasks gathers. Appearance keeps the app's look.
  import { _ } from 'svelte-i18n';
  import { linkPreviews, noteSort, keyboardShortcuts, cardDensity, swipeToArchive, tasksAllChecklists } from '../../stores/settings.js';
  import { linkPreviewsAvailable } from '../../lib/link-preview.js';
  import ShortcutsHelp from '../notes/ShortcutsHelp.svelte';

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
        <select class="select sel-sm" value={$cardDensity} on:change={e => cardDensity.set(e.target.value)}>
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
        <select class="select sel-sm" value={$noteSort} on:change={e => noteSort.set(e.target.value)}>
          <option value="edited">{$_('settings_page.notes.note_order_edited')}</option>
          <option value="custom">{$_('settings_page.notes.note_order_custom')}</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.notes.tasks_all')}</span>
        <div class="setting-desc">{$_('settings_page.notes.tasks_all_desc')}</div>
      </div>
      <input type="checkbox" class="toggle-cb" checked={$tasksAllChecklists} on:change={e => tasksAllChecklists.set(e.target.checked)} />
    </div>
    {#if !hasKeyboard}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_page.notes.swipe')}</span>
          <div class="setting-desc">{$_('settings_page.notes.swipe_desc')}</div>
        </div>
        <input type="checkbox" class="toggle-cb" checked={$swipeToArchive} on:change={e => swipeToArchive.set(e.target.checked)} />
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
        <input type="checkbox" class="toggle-cb" checked={$keyboardShortcuts} on:change={e => keyboardShortcuts.set(e.target.checked)} aria-label={$_('settings_page.notes.shortcuts')} />
      </div>
    {/if}
    {#if linkPreviewsAvailable}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_page.notes.link_previews')}</span>
          <div class="setting-desc">{$_('settings_page.notes.link_previews_desc')}</div>
        </div>
        <input type="checkbox" class="toggle-cb" checked={$linkPreviews} on:change={e => linkPreviews.set(e.target.checked)} />
      </div>
    {/if}
  </div>
</div>

<ShortcutsHelp bind:open={shortcutsOpen} />

<style>
  .section-body { display: flex; flex-direction: column; }
</style>
