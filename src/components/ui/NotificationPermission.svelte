<script>
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { LocalNotifications } from '@capacitor/local-notifications';
  import { isNative } from '../../lib/platform.js';
  import { requestPermission } from '../../lib/notifications.js';
  import { showSuccess, showError } from '../../stores/toast.js';

  let permission = 'default';
  let requesting = false;
  async function refresh() {
    if (isNative) {
      try { permission = (await LocalNotifications.checkPermissions()).display; }
      catch { permission = 'unsupported'; }
    } else {
      permission = !globalThis.isSecureContext ? 'insecure'
        : typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    }
  }
  onMount(() => {
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  });
  async function request() {
    requesting = true;
    try {
      const allowed = await requestPermission();
      await refresh();
      if (allowed) showSuccess($_('settings_notifications.toast.permission_granted'));
      else if (permission === 'denied') showError($_('settings_notifications.toast.permission_denied'));
    } finally { requesting = false; }
  }
</script>

<div class="permission-control">
  {#if permission === 'granted'}
    <span class="perm-ok"><span class="material-symbols-rounded" aria-hidden="true">check</span>{$_('settings_notifications.permission_allowed')}</span>
  {:else}
    <button class="btn btn-secondary" on:click={request} disabled={requesting || permission === 'insecure' || permission === 'unsupported' || permission === 'denied'}>
      {$_('settings_notifications.request_permission')}
    </button>
    {#if permission === 'denied'}<p>{$_('notification_history.blocked')}</p>
    {:else if permission === 'insecure'}<p>{$_('notification_history.https')}</p>
    {:else if permission === 'unsupported'}<p>{$_('settings_notifications.toast.not_supported')}</p>{/if}
  {/if}
</div>

<style>
  .permission-control { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  p { margin: 0; max-width: 320px; color: var(--text-3); font-size: 12px; line-height: 1.5; }
  .perm-ok { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--accent); }
  .perm-ok .material-symbols-rounded { font-size: 18px; }
</style>
