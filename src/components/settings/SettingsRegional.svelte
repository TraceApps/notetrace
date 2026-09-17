<script>
  // Regional section: language, date and time format.
  import { _ } from 'svelte-i18n';
  import { AVAILABLE_LOCALES } from '../../i18n/index.js';
  import { language, dateFormat, timeFormat } from '../../stores/settings.js';
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.regional.language')}</span>
        <div class="setting-desc">{$_('settings_page.regional.language_desc')}</div>
      </div>
      <div class="select-wrap" style="width:160px">
        <select aria-label={$_('settings_page.regional.language')} class="select sel-sm" value={$language} on:change={e => language.set(e.target.value)}>
          {#each AVAILABLE_LOCALES as loc (loc.code)}
            <option value={loc.code}>{loc.label}</option>
          {/each}
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings_page.regional.date_format')}</span>
      <div class="select-wrap" style="width:160px">
        <select aria-label={$_('settings_page.regional.date_format')} class="select sel-sm" value={$dateFormat} on:change={e => dateFormat.set(e.target.value)}>
          <option value="ISO">YYYY-MM-DD</option>
          <option value="US">MM/DD/YYYY</option>
          <option value="EU">DD/MM/YYYY</option>
          <option value="natural">{$_('settings_page.regional.date_natural')}</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings_page.regional.time_format')}</span>
      <div class="select-wrap" style="width:160px">
        <select aria-label={$_('settings_page.regional.time_format')} class="select sel-sm" value={$timeFormat} on:change={e => timeFormat.set(e.target.value)}>
          <option value="12h">12-hour (AM/PM)</option>
          <option value="24h">24-hour</option>
        </select>
      </div>
    </div>
  </div>
</div>

<style>
</style>
