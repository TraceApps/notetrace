<script>
  import Toggle from './Toggle.svelte';
  // App lock: require fingerprint, face, or the device PIN to open NoteTrace
  // on this device. Android only; stored per device.
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { appLockEnabled, appLockTimeoutMin } from '../../stores/settings.js';
  import { showError } from '../../stores/toast.js';
  import { setAuthenticating } from '../../lib/app-lock.js';

  let status = null;
  onMount(async () => {
    const { getStatus } = await import('../../lib/biometric.js');
    status = await getStatus();
  });

  // The switch follows the setting, and snaps back if the unlock check fails.
  let lockOn = false;
  $: lockOn = $appLockEnabled;
  async function onToggle(e) {
    const next = e.detail;
    if (!next) { appLockEnabled.set(false); return; }
    // Confirm the unlock works before turning the lock on.
    const { authenticateUnlock } = await import('../../lib/biometric.js');
    setAuthenticating(true);
    const ok = await authenticateUnlock($_('app_lock.confirm_prompt'));
    setAuthenticating(false);
    if (ok) appLockEnabled.set(true);
    else {
      lockOn = false;
      showError($_('app_lock.confirm_failed'));
    }
  }
</script>

<div class="applock-body">
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('app_lock.enable')}</span>
        <span class="setting-desc">{$_('app_lock.enable_desc')}</span>
      </div>
      <Toggle label={$_('app_lock.enable')} bind:checked={lockOn} on:change={onToggle} />
    </div>
    {#if $appLockEnabled}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('app_lock.timeout')}</span>
          <span class="setting-desc">{$_('app_lock.timeout_desc')}</span>
        </div>
        <select aria-label={$_('app_lock.timeout')} class="select sel-sm" value={String($appLockTimeoutMin)} on:change={(e) => appLockTimeoutMin.set(Number(e.target.value))}>
          <option value="0">{$_('app_lock.timeout_now')}</option>
          <option value="1">{$_('app_lock.timeout_1')}</option>
          <option value="5">{$_('app_lock.timeout_5')}</option>
          <option value="15">{$_('app_lock.timeout_15')}</option>
        </select>
      </div>
    {/if}
    {#if status && !status.isAvailable}
      <div class="setting-divider"></div>
      <p class="setting-desc note">{$_('app_lock.no_biometrics')}</p>
    {/if}
  </div>
</div>

<style>
  .card.settings-card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); overflow: hidden;
  }
  .setting-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; }
  .setting-row > div:first-child { flex: 1; min-width: 0; }
  .setting-label { font-size: 14px; color: var(--text-1); display: block; font-weight: 500; }
  .setting-desc { font-size: 12px; color: var(--text-3); margin-top: 4px; line-height: 1.45; display: block; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }
  .note { padding: 12px 16px; margin: 0; }
  .select {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--text-1); height: 36px; padding: 0 10px; font-size: 13px; cursor: pointer;
  }
</style>
