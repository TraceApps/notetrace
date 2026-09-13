<script>
  // Regional section, extracted from Settings.svelte. Owns language and
  // date/time format.
  // Stores + AVAILABLE_LOCALES import verbatim from the shell.
  import { _ } from 'svelte-i18n';
  import { AVAILABLE_LOCALES } from '../../i18n/index.js';
  import {
    language, dateFormat, timeFormat,
  } from '../../stores/settings.js';
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.regional.language')}</span>
        <div class="setting-desc">UI language. A translation may lag one or two releases behind English; missing strings fall back to English.</div>
      </div>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$language} on:change={e => language.set(e.target.value)}>
          {#each AVAILABLE_LOCALES as loc}
            <option value={loc.code}>{loc.label}</option>
          {/each}
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings_page.regional.date_format')}</span>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$dateFormat} on:change={e => dateFormat.set(e.target.value)}>
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
        <select class="select sel-sm" value={$timeFormat} on:change={e => timeFormat.set(e.target.value)}>
          <option value="12h">12-hour (AM/PM)</option>
          <option value="24h">24-hour</option>
        </select>
      </div>
    </div>
  </div>
</div>

<style>
  .select-wrap { position: relative; display: inline-block; }
  .select-wrap::after {
    content: '';
    position: absolute;
    right: 10px; top: 50%;
    transform: translateY(-25%) rotate(45deg);
    width: 7px; height: 7px;
    border-right: 2px solid var(--text-3);
    border-bottom: 2px solid var(--text-3);
    pointer-events: none;
  }
  .select {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 7px 28px 7px 10px;
    color: var(--text-1);
    font-size: 13px;
    width: 100%;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }
  .select:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .sel-sm { height: 36px; font-size: 13px; }
</style>
