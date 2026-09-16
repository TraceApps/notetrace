<script>
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
    } catch (e) {
      showError(e.message || $_('settings_notifications.toast.test_failed'));
      testStatus = 'fail';
    } finally {
      testing = false;
      setTimeout(() => { testStatus = ''; }, 5000);
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

<div class="notif-body">
  <p class="sub-label">{$_('settings_notifications.device_notifications')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.enable_on_device')}</span>
        <span class="setting-desc">{isNative ? $_('settings_notifications.enable_on_device_desc_native') : $_('settings_notifications.enable_on_device_desc_web')}</span>
      </div>
      <input aria-label={$_('settings_notifications.enable_on_device')} type="checkbox" class="toggle-cb" checked={$notifLocalEnabled}
        on:change={e => notifLocalEnabled.set(e.target.checked)} />
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

  <p class="sub-label">{$_('settings_notifications.push_service')}</p>
  <div class="card settings-card">
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
      <div class="setting-divider"></div>
      <div class="form-block">
        <label class="form-label" for="settings-notifications-field-1">{$_('settings_notifications.apprise_url')}</label>
        <input id="settings-notifications-field-1" class="input" type="url" placeholder="https://apprise.example.com"
          value={$appriseUrl} on:change={e => appriseUrl.set(e.target.value)} />
        <label class="form-label" for="settings-notifications-field-2">{$_('settings_notifications.apprise_tag')}</label>
        <input id="settings-notifications-field-2" class="input" type="text" placeholder={$_('settings_notifications.apprise_tag_placeholder')}
          value={$appriseTag} on:change={e => appriseTag.set(e.target.value)} />
      </div>
    {:else if $notifPushService === 'gotify'}
      <div class="setting-divider"></div>
      <div class="form-block">
        <label class="form-label" for="settings-notifications-field-3">{$_('settings_notifications.gotify_url')}</label>
        <input id="settings-notifications-field-3" class="input" type="url" placeholder="https://gotify.example.com"
          value={$gotifyUrl} on:change={e => gotifyUrl.set(e.target.value)} />
        <label class="form-label" for="settings-notifications-field-4">{$_('settings_notifications.app_token')}</label>
        <input id="settings-notifications-field-4" class="input" type="text"
          value={$gotifyToken} on:change={e => gotifyToken.set(e.target.value)} />
      </div>
    {:else if $notifPushService === 'ntfy'}
      <div class="setting-divider"></div>
      <div class="form-block">
        <label class="form-label" for="settings-notifications-field-5">{$_('settings_notifications.ntfy_server')}</label>
        <input id="settings-notifications-field-5" class="input" type="url" placeholder="https://ntfy.sh"
          value={$ntfyUrl} on:change={e => ntfyUrl.set(e.target.value)} />
        <label class="form-label" for="settings-notifications-field-6">{$_('settings_notifications.topic')}</label>
        <input id="settings-notifications-field-6" class="input" type="text" placeholder="notetrace-myhome"
          value={$ntfyTopic} on:change={e => ntfyTopic.set(e.target.value)} />
        <label class="form-label" for="settings-notifications-field-7">{$_('settings_notifications.ntfy_token')}</label>
        <input id="settings-notifications-field-7" class="input" type="text"
          value={$ntfyToken} on:change={e => ntfyToken.set(e.target.value)} />
      </div>
    {/if}

    {#if $notifPushService !== 'none'}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_notifications.send_test')}</span>
          <span class="setting-desc">{$_('settings_notifications.send_test_desc')}</span>
        </div>
        <button class="btn btn-primary" on:click={sendTestPush} disabled={testing}>
          {#if testStatus === 'ok'}
            <span class="material-symbols-rounded">check</span> {$_('settings_notifications.test_sent_short')}
          {:else if testStatus === 'fail'}
            <span class="material-symbols-rounded">error</span> {$_('settings_notifications.test_failed_short')}
          {:else}
            {testing ? $_('settings_notifications.sending') : $_('settings_notifications.send_test')}
          {/if}
        </button>
      </div>
    {/if}
  </div>

  <p class="sub-label">{$_('settings_notifications.reminders')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.note_reminders')}</span>
        <span class="setting-desc">{$_('settings_notifications.note_reminders_desc')}</span>
      </div>
      <input aria-label={$_('settings_notifications.note_reminders')} type="checkbox" class="toggle-cb" checked={notifNoteReminders}
        on:change={e => { notifNoteReminders = e.target.checked; toggleReminder('notifNoteReminders', e.target.checked); }} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.tasks_due')}</span>
        <span class="setting-desc">{$_('settings_notifications.tasks_due_desc')}</span>
      </div>
      <input aria-label={$_('settings_notifications.tasks_due')} type="checkbox" class="toggle-cb" checked={notifTasksDue}
        on:change={e => { notifTasksDue = e.target.checked; toggleReminder('notifTasksDue', e.target.checked); window.dispatchEvent(new CustomEvent('note:tasks-digest-changed')); }} />
    </div>
    {#if notifTasksDue}
      <div class="setting-row">
        <span class="setting-label">{$_('settings_notifications.tasks_due_time')}</span>
        <input aria-label={$_('settings_notifications.tasks_due_time')} class="input time-input" type="time" value={tasksDigestTime}
          on:change={e => { tasksDigestTime = e.target.value || '09:00'; setS('tasksDigestTime', tasksDigestTime); window.dispatchEvent(new CustomEvent('note:tasks-digest-changed')); }} />
      </div>
    {/if}
  </div>
</div>

<style>
  .notif-body { display: flex; flex-direction: column; gap: 10px; }
  /* Two classes, so the shared .input width: 100% can't stretch the clock and
     squeeze the label into a column of letters. */
  .input.time-input { width: 130px; flex: 0 0 auto; }
  .sub-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
    padding: 4px 2px 2px;
    margin: 0;
  }
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
  .form-block { padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; }
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
