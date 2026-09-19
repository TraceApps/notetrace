<script>
  import Toggle from './Toggle.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  // SettingsNotifications — device + push-service reminders.
  //
  // Two delivery channels (NT parity):
  //   - Device notifications: the browser while NoteTrace is open
  //     (web-reminders.js), native exact alarms on Android
  //     (note-reminders.js).
  //   - Push service: Apprise / Gotify / ntfy. Server-side. Secrets stay
  //     on the server.
  //
  // Per-reminder switches gate which NoteTrace events fire on push:
  //   - Note reminders (a note's reminder time comes due)
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { isNative, getServerUrl, getAuthToken, apiUrl } from '../../lib/platform.js';
  import {
    notifLocalEnabled, notifPushService,
    appriseUrl, appriseTag,
    gotifyUrl, gotifyToken,
    ntfyUrl, ntfyTopic, ntfyToken,
  } from '../../stores/settings.js';
  import { DB } from '../../lib/db.js';
  import { scheduleSave } from '../../stores/settings.js';

  function setS(key, value) { DB.setSetting(key, value); scheduleSave(key, value); }

  // Per-reminder toggles — stored straight on DB.setSetting (no
  // auto-bound store needed; small set, default off, plain keys).
  function getBool(key, def = false) {
    const v = DB.getSetting(key, def);
    return v === true || v === 'true';
  }
  let notifNoteReminders   = getBool('notifNoteReminders', true);
  let notifTasksDue        = getBool('notifTasksDue', true);
  let tasksDigestTime      = String(DB.getSetting('tasksDigestTime', '09:00') || '09:00');
  let browserPermission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';

  // Android: reminders fire at the exact minute only with the exact-alarm
  // permission (granted automatically on most phones).
  let exactAlarms = true;
  async function refreshExact() {
    if (!isNative) return;
    const { exactAlarmStatus } = await import('../../lib/note-reminders.js');
    exactAlarms = (await exactAlarmStatus()).exact !== false;
  }
  async function allowExact() {
    const { openExactAlarmSettings } = await import('../../lib/note-reminders.js');
    await openExactAlarmSettings();
  }
  onMount(() => {
    refreshExact();
    const onVis = () => { if (!document.hidden) refreshExact(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  });

  function toggleReminder(key, value) {
    setS(key, value);
  }

  // Test push
  let testing = false;
  let testStatus = ''; // 'ok' | 'fail' | ''
  let testError = '';
  // The push service's status bar, as in NutriTrace: set up, testing, or failed.
  $: pushConfigured = $notifPushService === 'ntfy' ? !!($ntfyUrl && $ntfyTopic)
    : $notifPushService === 'gotify' ? !!($gotifyUrl && $gotifyToken)
    : $notifPushService === 'apprise' ? !!$appriseUrl
    : false;
  $: pushStatus = testing ? 'testing' : testStatus === 'fail' ? 'fail' : (pushConfigured ? 'ok' : '');
  $: pushProviderLabel = { ntfy: 'ntfy', gotify: 'Gotify', apprise: 'Apprise' }[$notifPushService] || '';
  let lastProvider = null;
  $: if ($notifPushService !== lastProvider) { lastProvider = $notifPushService; testStatus = ''; testError = ''; }
  let showGotifyToken = false, showNtfyToken = false;
  async function sendTestPush() {
    testing = true;
    testStatus = '';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (isNative && getServerUrl()) {
        const t = getAuthToken();
        if (t) headers['Authorization'] = `Bearer ${t}`;
      } else {
        const csrf = localStorage.getItem('note:csrf');
        if (csrf) headers['X-CSRF-Token'] = csrf;
      }
      const res = await fetch(apiUrl('/api/notify/test'), {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      showSuccess($_('settings_notifications.toast.test_sent'));
      testStatus = 'ok';
      testError = '';
    } catch (e) {
      testError = e.message || $_('settings_notifications.toast.test_failed');
      testStatus = 'fail';
    } finally {
      testing = false;
    }
  }

  // Device notifications: ask permission on Web (Capacitor handles
  // separately on the native side via the Settings UI).
  async function requestDevicePermission() {
    if (typeof Notification === 'undefined') {
      showError($_('settings_notifications.toast.not_supported'));
      return;
    }
    try {
      const result = await Notification.requestPermission();
      browserPermission = result;
      if (result === 'granted') showSuccess($_('settings_notifications.toast.permission_granted'));
      else if (result === 'denied') showError($_('settings_notifications.toast.permission_denied'));
    } catch (e) {
      showError(e.message || 'Permission request failed');
    }
  }
</script>

<div class="section-body">
  <p class="settings-group-heading">{$_('settings_notifications.device_notifications')}</p>
  <p class="settings-group-sub">{$_('settings_notifications.device_notifications_sub')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.enable_on_device')}</span>
        <span class="setting-desc">{isNative ? $_('settings_notifications.enable_on_device_desc_native') : $_('settings_notifications.enable_on_device_desc_web')}</span>
      </div>
      <Toggle label={$_('settings_notifications.enable_on_device')} checked={$notifLocalEnabled} on:change={e => notifLocalEnabled.set(e.detail)} />
    </div>
    {#if isNative && !exactAlarms}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_notifications.exact_alarms')}</span>
          <span class="setting-desc">{$_('settings_notifications.exact_alarms_desc')}</span>
        </div>
        <button class="btn btn-secondary" on:click={allowExact}>{$_('settings_notifications.exact_alarms_allow')}</button>
      </div>
    {/if}
    {#if !isNative}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_notifications.browser_permission')}</span>
          <span class="setting-desc">{$_('settings_notifications.browser_permission_desc')}</span>
        </div>
        {#if browserPermission === 'granted'}
          <span class="perm-ok"><span class="material-symbols-rounded">check</span>{$_('settings_notifications.permission_allowed')}</span>
        {:else}
          <button class="btn btn-secondary" on:click={requestDevicePermission}>
            {$_('settings_notifications.request_permission')}
          </button>
        {/if}
      </div>
    {/if}
  </div>

  <p class="settings-group-heading">{$_('settings_notifications.push_service')}</p>
  <p class="settings-group-sub">{$_('settings_notifications.push_service_sub')}</p>
  <div class="card settings-card">
    {#if $notifPushService !== 'none'}
      <ConnectionStatus
        status={pushStatus}
        okLabel={$_('settings_notifications.push_configured')}
        connectedAs={pushProviderLabel}
        error={testStatus === 'fail' ? testError : ''}
        onRetest={sendTestPush}
        retestDisabled={testing || !pushConfigured}
        retestLabel={$_('settings_notifications.send_test')}
        testingLabel={$_('settings_notifications.sending')}
      />
    {/if}
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.service')}</span>
        <span class="setting-desc">{$_('settings_notifications.service_desc')}</span>
      </div>
      <div class="select-wrap">
        <select aria-label={$_('settings_notifications.service')} class="select sel-sm" value={$notifPushService}
          on:change={e => notifPushService.set(e.target.value)}>
          <option value="none">{$_('settings_notifications.svc_none')}</option>
          <option value="apprise">{$_('settings_notifications.svc_apprise')}</option>
          <option value="gotify">{$_('settings_notifications.svc_gotify')}</option>
          <option value="ntfy">ntfy</option>
        </select>
      </div>
    </div>

    {#if $notifPushService === 'apprise'}
      <div class="form-group" style="padding:10px 16px 4px">
        <label class="form-label" for="notif-apprise-url">{$_('settings_notifications.apprise_url')}</label>
        <input id="notif-apprise-url" class="input" type="url" placeholder="https://apprise.example.com"
          value={$appriseUrl} on:change={e => appriseUrl.set(e.target.value)} />
      </div>
      <div class="form-group" style="padding:8px 16px 14px">
        <label class="form-label" for="notif-apprise-tag">{$_('settings_notifications.apprise_tag')}</label>
        <input id="notif-apprise-tag" class="input" type="text" placeholder={$_('settings_notifications.apprise_tag_placeholder')}
          value={$appriseTag} on:change={e => appriseTag.set(e.target.value)} />
      </div>
    {:else if $notifPushService === 'gotify'}
      <div class="form-group" style="padding:10px 16px 4px">
        <label class="form-label" for="notif-gotify-url">{$_('settings_notifications.gotify_url')}</label>
        <input id="notif-gotify-url" class="input" type="url" placeholder="https://gotify.example.com"
          value={$gotifyUrl} on:change={e => gotifyUrl.set(e.target.value)} />
      </div>
      <div class="form-group" style="padding:8px 16px 14px">
        <label class="form-label" for="notif-gotify-token">{$_('settings_notifications.app_token')}</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="notif-gotify-token" class="input" style="flex:1" type={showGotifyToken ? 'text' : 'password'} autocomplete="off"
            value={$gotifyToken} on:change={e => gotifyToken.set(e.target.value)} />
          <button type="button" class="btn-icon" on:click={() => showGotifyToken = !showGotifyToken}
            title={showGotifyToken ? $_('settings_notifications.hide') : $_('settings_notifications.show')} aria-label={showGotifyToken ? $_('settings_notifications.hide') : $_('settings_notifications.show')}>
            <span class="material-symbols-rounded">{showGotifyToken ? 'visibility_off' : 'visibility'}</span>
          </button>
        </div>
      </div>
    {:else if $notifPushService === 'ntfy'}
      <div class="form-group" style="padding:10px 16px 4px">
        <label class="form-label" for="notif-ntfy-url">{$_('settings_notifications.ntfy_server')}</label>
        <input id="notif-ntfy-url" class="input" type="url" placeholder="https://ntfy.sh"
          value={$ntfyUrl} on:change={e => ntfyUrl.set(e.target.value)} />
      </div>
      <div class="form-group" style="padding:8px 16px 4px">
        <label class="form-label" for="notif-ntfy-topic">{$_('settings_notifications.topic')}</label>
        <input id="notif-ntfy-topic" class="input" type="text" placeholder="notetrace-myhome"
          value={$ntfyTopic} on:change={e => ntfyTopic.set(e.target.value)} />
      </div>
      <div class="form-group" style="padding:8px 16px 14px">
        <label class="form-label" for="notif-ntfy-token">{$_('settings_notifications.ntfy_token')}</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="notif-ntfy-token" class="input" style="flex:1" type={showNtfyToken ? 'text' : 'password'} autocomplete="off"
            value={$ntfyToken} on:change={e => ntfyToken.set(e.target.value)} />
          <button type="button" class="btn-icon" on:click={() => showNtfyToken = !showNtfyToken}
            title={showNtfyToken ? $_('settings_notifications.hide') : $_('settings_notifications.show')} aria-label={showNtfyToken ? $_('settings_notifications.hide') : $_('settings_notifications.show')}>
            <span class="material-symbols-rounded">{showNtfyToken ? 'visibility_off' : 'visibility'}</span>
          </button>
        </div>
      </div>
    {/if}

  </div>

  <p class="settings-group-heading">{$_('settings_notifications.reminders')}</p>
  <p class="settings-group-sub">{$_('settings_notifications.reminders_sub')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.note_reminders')}</span>
        <span class="setting-desc">{$_('settings_notifications.note_reminders_desc')}</span>
      </div>
      <Toggle label={$_('settings_notifications.note_reminders')} checked={notifNoteReminders} on:change={e => { notifNoteReminders = e.detail; toggleReminder('notifNoteReminders', e.detail); }} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.tasks_due')}</span>
        <span class="setting-desc">{$_('settings_notifications.tasks_due_desc')}</span>
      </div>
      <Toggle label={$_('settings_notifications.tasks_due')} checked={notifTasksDue} on:change={e => { notifTasksDue = e.detail; toggleReminder('notifTasksDue', e.detail); window.dispatchEvent(new CustomEvent('note:tasks-digest-changed')); }} />
    </div>
    {#if notifTasksDue}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">{$_('settings_notifications.tasks_due_time')}</span>
        <input aria-label={$_('settings_notifications.tasks_due_time')} class="input time-input" type="time" value={tasksDigestTime}
          on:change={e => { tasksDigestTime = e.target.value || '09:00'; setS('tasksDigestTime', tasksDigestTime); window.dispatchEvent(new CustomEvent('note:tasks-digest-changed')); }} />
      </div>
    {/if}
  </div>
</div>

<style>
  /* Two classes, so the shared .input width: 100% can't stretch the clock and
     squeeze the label into a column of letters. */
  .input.time-input { width: 130px; flex: 0 0 auto; }
  .card.settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .setting-row {
    display: flex; justify-content: space-between; align-items: center;
    gap: 12px; padding: 14px 16px;
  }
  .setting-row > div:first-child { flex: 1; min-width: 0; }
  /* A row whose label isn't wrapped in a div still takes the space it needs. */
  .setting-row > .setting-label { flex: 1; min-width: 0; }
  .setting-label { font-size: 14px; color: var(--text-1); display: block; font-weight: 500; }
  .setting-desc { font-size: 12px; color: var(--text-3); margin-top: 4px; line-height: 1.4; display: block; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }
  .form-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    margin-top: 6px;
  }
  .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px;
    color: var(--text-1); font-size: 14px;
    box-sizing: border-box; width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .select-wrap { position: relative; }
  .select {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 7px 10px;
    color: var(--text-1); font-size: 13px;
    appearance: none; -webkit-appearance: none; cursor: pointer;
  }
  .select.sel-sm { height: 36px; }
  .perm-ok { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--accent); white-space: nowrap; }
  .perm-ok .material-symbols-rounded { font-size: 18px; }
</style>
