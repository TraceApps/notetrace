<script>
  /**
   * SettingsBackup — full DB+uploads ZIP backups + portable JSON.
   *
   * Mirrors NutriTrace's SettingsBackup layout exactly:
   *   - "FULL BACKUP" sub-label + a single card with description, the
   *     Create Backup / Upload & Restore button row, and (when present)
   *     the table of existing backups (Name / Created / Size + per-row
   *     Download / Restore / Delete).
   *   - "PORTABLE JSON EXPORT" sub-label + a card with two action rows:
   *     Export JSON (no images) and Import JSON (merges).
   */
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { slide } from 'svelte/transition';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { DB } from '../../lib/db.js';
  import { isNative, getServerUrl, getAuthToken, apiUrl } from '../../lib/platform.js';
  import { currentUser, userMgmtActive } from '../../stores/auth.js';
  import TimePicker from '../ui/TimePicker.svelte';
  import {
    localBackupSchedule, localBackupTime, localBackupRetention,
    localBackupLastRun, localBackupLastError,
  } from '../../stores/settings.js';

  let fullBackups = [];
  let fullBackupBusy = false;
  let restoreStatus = null; // { label, percent } | null
  let uploadInput;
  let importJsonInput;
  let importZipInput;
  let localBackupBusy = false;

  // Scheduled-backup state (TraceApps parity with NutriTrace). Server-mode
  // schedule lives in app_config and is admin-only; local-mode schedule is
  // per-device in localStorage. Same shape, different storage.
  let scheduleCfg = null;
  let scheduleBusy = false;

  export async function loadSchedule() {
    if (!showServerSection) return;
    try {
      const res = await fetch(apiUrl('/api/full-backup/schedule'), _fetchOpts());
      if (!res.ok) return;
      scheduleCfg = await res.json();
    } catch {}
  }

  async function saveSchedule(patch) {
    if (!scheduleCfg || scheduleCfg.envLocked) return;
    scheduleBusy = true;
    try {
      const res = await fetch(apiUrl('/api/full-backup/schedule'), {
        method: 'PUT',
        body: JSON.stringify(patch),
        ..._fetchOpts({ 'Content-Type': 'application/json' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data.error || 'Save failed');
        await loadSchedule();
        return;
      }
      scheduleCfg = data;
    } catch (e) {
      showError(e?.message || 'Save failed');
    } finally {
      scheduleBusy = false;
    }
  }

  $: localScheduleCfg = (isNative && !serverEnabled) ? {
    schedule:      $localBackupSchedule  || 'off',
    time:          $localBackupTime      || '03:00',
    retention:     parseInt($localBackupRetention, 10) || 7,
    lastAutoRun:   $localBackupLastRun   || null,
    lastAutoError: $localBackupLastError || null,
    envLocked:     false,
  } : null;

  function saveLocalSchedule(patch) {
    if (!(isNative && !serverEnabled)) return;
    if (patch.schedule != null && ['off','daily','weekly','monthly'].includes(patch.schedule)) {
      localBackupSchedule.set(patch.schedule);
    }
    if (patch.time != null && /^\d{1,2}:\d{2}$/.test(patch.time)) {
      const [h, m] = patch.time.split(':').map(n => parseInt(n, 10));
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        localBackupTime.set(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
      }
    }
    if (patch.retention != null) {
      const r = parseInt(patch.retention, 10);
      if (Number.isFinite(r) && r >= 1 && r <= 99) localBackupRetention.set(r);
    }
  }

  function _formatRelative(iso) {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    const hours = ms / 3_600_000;
    if (hours < 1)   return `${Math.max(1, Math.round(ms / 60_000))} Min Ago`;
    if (hours < 36)  return `${Math.round(hours)} Hr Ago`;
    return `${Math.round(hours / 24)} Days Ago`;
  }
  function _nextDueLabel(cfg) {
    if (!cfg || cfg.schedule === 'off') return null;
    const [hh, mm] = cfg.time.split(':').map(n => parseInt(n, 10));
    const intervalDays = { daily: 1, weekly: 7, monthly: 28 }[cfg.schedule] || 1;
    const now = new Date();
    let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0);
    if (cfg.lastAutoRun) {
      const last = new Date(cfg.lastAutoRun).getTime();
      while (next.getTime() <= now.getTime() || (next.getTime() - last) / 86_400_000 < intervalDays - 0.5) {
        next = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1, hh, mm, 0);
      }
    } else if (next.getTime() <= now.getTime()) {
      next = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1, hh, mm, 0);
    }
    return next.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  $: serverEnabled = !isNative || !!getServerUrl();
  $: isAdmin = !$userMgmtActive || $currentUser?.role === 'admin';
  $: showServerSection = serverEnabled && isAdmin;

  function _fetchOpts(extra = {}) {
    const h = { ...extra };
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    } else {
      const csrf = localStorage.getItem('note:csrf');
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    return { credentials: 'include', headers: h };
  }

  function fmtBytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  export async function loadFullBackups() {
    if (!showServerSection) return;
    try {
      const res = await fetch(apiUrl('/api/full-backup'), _fetchOpts());
      if (!res.ok) {
        // Auth gates are expected (user just isn't admin / not signed in)
        // — leave the list empty silently in that case. Any other non-2xx
        // is an actual failure the user should know about so an empty
        // table doesn't get misread as "no backups yet."
        if (res.status === 403 || res.status === 401) { fullBackups = []; return; }
        const body = await res.json().catch(() => ({}));
        showError(body?.error || `Couldn't load backups (${res.status})`);
        return;
      }
      fullBackups = await res.json();
    } catch (e) {
      showError(e?.message || "Couldn't reach the server to load backups");
    }
  }

  onMount(async () => {
    await loadFullBackups();
    await loadSchedule();
  });

  async function createFullBackup() {
    fullBackupBusy = true;
    restoreStatus = { label: 'Creating backup…', percent: 25 };
    try {
      const res = await fetch(apiUrl('/api/full-backup'), {
        method: 'POST', ..._fetchOpts({ 'Content-Type': 'application/json' }),
      });
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const result = await res.json();
      showSuccess(`Backup created (${fmtBytes(result.size)})`);
      await loadFullBackups();
    } catch (e) {
      showError(e.message || 'Backup failed');
    } finally {
      fullBackupBusy = false;
      restoreStatus = null;
    }
  }

  function downloadFullBackup(filename) {
    const url = apiUrl(`/api/full-backup/${encodeURIComponent(filename)}/download`);
    if (isNative && getAuthToken()) {
      window.open(`${url}?token=${encodeURIComponent(getAuthToken())}`, '_blank');
    } else {
      window.location.href = url;
    }
  }

  async function deleteFullBackup(filename) {
    const ok = await confirmDialog({
      title: 'Delete backup?',
      message: `"${filename}" will be removed from the server. This cannot be undone.`,
      confirmText: 'Delete', dangerous: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(apiUrl(`/api/full-backup/${encodeURIComponent(filename)}`), {
        method: 'DELETE', ..._fetchOpts(),
      });
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      showSuccess($_('backup_page.toast.deleted'));
      await loadFullBackups();
    } catch (e) {
      showError(e.message || 'Delete failed');
    }
  }

  async function restoreFullBackup(filename) {
    const ok = await confirmDialog({
      title: 'Restore from this backup?',
      message: 'All current NoteTrace data will be REPLACED. Make sure you have a fresh backup before continuing.',
      confirmText: 'Restore', dangerous: true,
    });
    if (!ok) return;
    fullBackupBusy = true;
    restoreStatus = { label: 'Restoring backup…', percent: 50 };
    try {
      const res = await fetch(apiUrl(`/api/full-backup/${encodeURIComponent(filename)}/restore`), {
        method: 'POST', ..._fetchOpts({ 'Content-Type': 'application/json' }),
      });
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      restoreStatus = { label: 'Reloading…', percent: 100 };
      showSuccess($_('backup_page.toast.restored_reloading'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      showError(e.message || 'Restore failed');
      restoreStatus = null;
      fullBackupBusy = false;
    }
  }

  function pickUploadRestore() {
    if (uploadInput) uploadInput.click();
  }
  async function onUploadFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const ok = await confirmDialog({
      title: 'Restore from upload?',
      message: 'All current NoteTrace data will be REPLACED with the contents of the uploaded ZIP.',
      confirmText: 'Restore', dangerous: true,
    });
    if (!ok) {
      if (uploadInput) uploadInput.value = '';
      return;
    }
    fullBackupBusy = true;
    restoreStatus = { label: 'Uploading + restoring…', percent: 50 };
    try {
      const form = new FormData();
      form.append('backup', file);
      const opts = _fetchOpts();
      const res = await fetch(apiUrl('/api/full-backup/upload-restore'), {
        method: 'POST', body: form, ...opts,
      });
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      restoreStatus = { label: 'Reloading…', percent: 100 };
      showSuccess($_('backup_page.toast.restored_reloading'));
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      showError(e.message || 'Restore failed');
      restoreStatus = null;
      fullBackupBusy = false;
      if (uploadInput) uploadInput.value = '';
    }
  }

  // ── Danger zone ────────────────────────────────────────────────────────
  // Mirrors NutriTrace exactly. Two destructive operations:
  //   * Clear all data: soft-deletes every note
  //     list rows for the current user (server keeps tombstones so sync
  //     across devices propagates the deletion correctly).
  //   • Clear all settings — wipes per-user user_settings rows on the
  //     server and removes the wl_u<id>_* localStorage prefix so the next
  //     load sees defaults. Keeps notes intact.
  let showClearDialog = false;
  let showClearSettingsDialog = false;

  async function clearAllData() {
    try {
      const res = await fetch(apiUrl('/api/data'), { method: 'DELETE', ..._fetchOpts() });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      showSuccess($_('backup_page.toast.all_data_cleared'));
      // Reload so every route's local state re-fetches and reflects
      // the empty database.
      setTimeout(() => location.reload(), 800);
    } catch (e) { showError($_('backup_page.toast.clear_failed', { values: { msg: e.message || e } })); }
  }

  async function clearAllSettings() {
    try {
      const res = await fetch(apiUrl('/api/settings'), { method: 'DELETE', ..._fetchOpts() });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      // Wipe per-user prefixed localStorage so client-side stores reset
      // to defaults on reload. Mirrors NT's prefix logic verbatim.
      const userId = localStorage.getItem('wl:userId');
      const prefix = userId ? `wl_u${userId}_` : 'wl_';
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
      // Keep wizard from re-running — settings cleared is not a fresh install.
      DB.setSetting('setupComplete', true);
      showSuccess($_('backup_page.toast.all_settings_cleared'));
      setTimeout(() => location.reload(), 800);
    } catch (e) { showError($_('backup_page.toast.clear_failed', { values: { msg: e.message || e } })); }
  }

  async function _confirmClearAllData() {
    const ok = await confirmDialog({
      title: 'Clear all data?',
      message: 'This will permanently delete all notes. Settings and credentials are kept. This cannot be undone.',
      confirmText: 'Delete All Data',
      dangerous: true,
    });
    if (ok) await clearAllData();
  }
  async function _confirmClearAllSettings() {
    const ok = await confirmDialog({
      title: 'Clear all settings?',
      message: 'This will reset all preferences, credentials, and API keys to defaults. Notes and other data are kept. This cannot be undone.',
      confirmText: 'Clear All Settings',
      dangerous: true,
    });
    if (ok) await clearAllSettings();
  }

  // ── Portable JSON ─────────────────────────────────────────────────────
  async function exportBackup() {
    try {
      // Native local mode: dump the on-device SQLite DB. The IndexedDB
      // shim has no useful data in that mode.
      let data;
      if (isNative && !getServerUrl()) {
        const { exportLocalSnapshot } = await import('../../lib/local-backup.js');
        data = await exportLocalSnapshot();
      } else {
        data = await DB.exportAll();
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const fileName = `notetrace-export-${new Date().toISOString().slice(0,10)}.json`;

      // On native, route through @capacitor/share so the user can pick
      // a destination (save to Files, send via email, etc.).
      if (isNative) {
        try {
          const { Filesystem, Directory } = await import('@capacitor/filesystem');
          const { Share } = await import('@capacitor/share');
          const b64 = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onloadend = () => {
              const s = String(r.result || '');
              const i = s.indexOf(',');
              resolve(i >= 0 ? s.slice(i + 1) : s);
            };
            r.onerror = reject;
            r.readAsDataURL(blob);
          });
          await Filesystem.writeFile({ path: `exports/${fileName}`, data: b64, directory: Directory.Cache, recursive: true });
          const { uri } = await Filesystem.getUri({ path: `exports/${fileName}`, directory: Directory.Cache });
          await Share.share({ title: 'NoteTrace Backup', url: uri, dialogTitle: 'Save backup' });
          showSuccess($_('backup_page.toast.exported'));
          return;
        } catch (e) {
          // Fall through to <a download> if share path fails.
          console.warn('[backup] native share failed, falling back to download', e);
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      showSuccess($_('backup_page.toast.exported'));
    } catch (e) {
      showError(e.message || 'Export failed');
    }
  }
  function importBackup() {
    if (importJsonInput) importJsonInput.click();
  }
  // ── Local full backup (Android local mode) ─────────────────────
  // Same card as NutriTrace: Create Backup saves a .zip to
  // Documents/notetrace-backups (where the scheduler writes too), and the
  // list below shares, restores, or deletes them.
  const LOCAL_BACKUP_DIR = 'notetrace-backups';
  let localBackups = [];
  let localZipStatus = '';

  export async function loadLocalBackups() {
    if (!(isNative && !serverEnabled)) return;
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      await Filesystem.mkdir({ path: LOCAL_BACKUP_DIR, directory: Directory.Documents, recursive: true }).catch(() => {});
      const list = await Filesystem.readdir({ path: LOCAL_BACKUP_DIR, directory: Directory.Documents });
      localBackups = (list.files || [])
        .filter(f => f.name && f.name.endsWith('.zip'))
        .map(f => ({ filename: f.name, size: f.size || 0, createdAt: f.mtime ? new Date(f.mtime).toISOString() : new Date().toISOString() }))
        .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    } catch (e) {
      console.warn('[backup] list failed:', e.message);
      localBackups = [];
    }
  }

  async function exportLocalZipBackup() {
    if (localBackupBusy) return;
    localBackupBusy = true;
    localZipStatus = $_('backup_page.working');
    try {
      const { exportLocalZip } = await import('../../lib/local-backup.js');
      const blob = await exportLocalZip();
      const filename = `notetrace-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      await Filesystem.mkdir({ path: LOCAL_BACKUP_DIR, directory: Directory.Documents, recursive: true }).catch(() => {});
      await Filesystem.writeFile({ path: `${LOCAL_BACKUP_DIR}/${filename}`, data: btoa(binary), directory: Directory.Documents });
      showSuccess($_('backup_page.toast.backup_saved'));
      await loadLocalBackups();
    } catch (e) {
      showError(e.message || 'Backup failed');
    } finally {
      localZipStatus = '';
      localBackupBusy = false;
    }
  }
  function importLocalZipBackup() {
    if (importZipInput) importZipInput.click();
  }
  async function _restoreLocalBlob(blob) {
    localBackupBusy = true;
    localZipStatus = $_('backup_page.working');
    try {
      const { importLocalZip } = await import('../../lib/local-backup.js');
      await importLocalZip(blob);
      showSuccess($_('backup_page.toast.restored_reloading'));
      setTimeout(() => window.location.reload(), 400);
    } catch (e) {
      showError(e.message || 'Restore failed');
    } finally {
      localZipStatus = '';
      localBackupBusy = false;
    }
  }
  async function onImportZipFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (importZipInput) importZipInput.value = '';
    if (!await confirmDialog({ title: $_('backup_page.restore_title'), message: $_('backup_page.restore_message'), confirmText: $_('backup_page.restore'), dangerous: true })) return;
    await _restoreLocalBlob(file);
  }
  async function restoreLocalBackup(filename) {
    if (localBackupBusy) return;
    if (!await confirmDialog({ title: $_('backup_page.restore_title'), message: $_('backup_page.restore_message'), confirmText: $_('backup_page.restore'), dangerous: true })) return;
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const res = await Filesystem.readFile({ path: `${LOCAL_BACKUP_DIR}/${filename}`, directory: Directory.Documents });
      const blob = typeof res.data === 'string'
        ? new Blob([Uint8Array.from(atob(res.data), c => c.charCodeAt(0))], { type: 'application/zip' })
        : res.data;
      await _restoreLocalBlob(blob);
    } catch (e) {
      showError(e.message || 'Restore failed');
    }
  }
  async function deleteLocalBackup(filename) {
    if (!await confirmDialog({ title: $_('backup_page.delete_title'), message: filename, confirmText: $_('backup_page.delete'), dangerous: true })) return;
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      await Filesystem.deleteFile({ path: `${LOCAL_BACKUP_DIR}/${filename}`, directory: Directory.Documents });
      showSuccess($_('backup_page.toast.deleted'));
      await loadLocalBackups();
    } catch (e) {
      showError(e.message || 'Delete failed');
    }
  }
  async function shareLocalBackup(filename) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const { uri } = await Filesystem.getUri({ path: `${LOCAL_BACKUP_DIR}/${filename}`, directory: Directory.Documents });
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: 'NoteTrace Backup', files: [uri] });
    } catch (e) {
      if (!/cancel/i.test(e?.message || '')) showError(e.message || 'Share failed');
    }
  }
  onMount(loadLocalBackups);

  async function onImportJsonFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (importJsonInput) importJsonInput.value = '';
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      // Detect local-snapshot format and route to the SQLite importer.
      if (data?.format === 'notetrace-local-snapshot' && isNative) {
        const { importLocalSnapshot } = await import('../../lib/local-backup.js');
        await importLocalSnapshot(data);
        showSuccess($_('backup_page.toast.imported_reloading'));
        setTimeout(() => window.location.reload(), 400);
        return;
      }
      if (typeof DB.importAll === 'function') {
        await DB.importAll(data);
      } else {
        // Best-effort: replay setting() for each top-level setting key so
        // the JSON export round-trips even on the lightweight DB shim.
        if (data && data.settings && typeof data.settings === 'object') {
          for (const [k, v] of Object.entries(data.settings)) DB.setSetting(k, v);
        }
      }
      showSuccess($_('backup_page.toast.imported'));
    } catch (e) {
      showError(e.message || 'Import failed');
    }
  }
</script>

<div class="section-body">
  <!-- ── FULL BACKUP ───────────────────────────────────────────────── -->
  {#if showServerSection}
    <p class="settings-group-heading">{$_('backup_page.full_backup')}</p>
    <p class="settings-group-sub">{$_('backup_page.full_backup_sub')}</p>
    <div class="card settings-card">
      <div style="padding:12px 16px 4px">
        <p class="setting-desc" style="margin:0 0 12px">
          A complete snapshot of everything: notes, settings, and uploaded images. Saved on the server and available to download or restore at any time.
        </p>

        <!-- Auto Backup — admin schedules nightly / weekly / monthly
             archives. Off by default; mirrors NutriTrace's scheduled-
             backup feature for TraceApps parity. -->
        {#if scheduleCfg}
          <div class="auto-bk">
            <div class="auto-bk-head">
              <span class="auto-bk-title">{$_('backup_page.auto_backup')}</span>
              {#if scheduleCfg.envLocked}
                <span class="env-lock-pill" title={$_('backup_page.env_lock_title')}>{$_('backup_page.env_lock_pill')}</span>
              {/if}
            </div>
            <div class="auto-bk-fields">
              <label class="auto-bk-field">
                <span class="auto-bk-label">{$_('backup_page.schedule')}</span>
                <select class="select sel-sm"
                  bind:value={scheduleCfg.schedule}
                  disabled={scheduleCfg.envLocked || scheduleBusy}
                  on:change={() => saveSchedule({ schedule: scheduleCfg.schedule })}>
                  <option value="off">Off</option>
                  <option value="daily">{$_('backup_page.daily')}</option>
                  <option value="weekly">{$_('backup_page.weekly')}</option>
                  <option value="monthly">{$_('backup_page.monthly')}</option>
                </select>
              </label>
              {#if scheduleCfg.schedule !== 'off'}
                <label class="auto-bk-field">
                  <span class="auto-bk-label">{$_('backup_page.time')}</span>
                  <TimePicker value={scheduleCfg.time}
                    disabled={scheduleCfg.envLocked || scheduleBusy}
                    on:change={(e) => saveSchedule({ time: e.detail })} />
                </label>
                <label class="auto-bk-field">
                  <span class="auto-bk-label">{$_('backup_page.keep_last')}</span>
                  <input class="input" type="number" min="1" max="99"
                    bind:value={scheduleCfg.retention}
                    disabled={scheduleCfg.envLocked || scheduleBusy}
                    on:change={() => saveSchedule({ retention: scheduleCfg.retention })} />
                </label>
              {/if}
            </div>
            {#if scheduleCfg.schedule !== 'off'}
              <div class="auto-bk-status">
                {#if scheduleCfg.lastAutoError}
                  <div class="auto-bk-status-row error">
                    <span class="material-symbols-rounded" style="font-size:16px">error</span>
                    <span>Last auto-backup failed: {scheduleCfg.lastAutoError}</span>
                  </div>
                {/if}
                {#if scheduleCfg.lastAutoRun}
                  <div class="auto-bk-status-row">
                    <span class="material-symbols-rounded" style="font-size:16px">check_circle</span>
                    <span>Last auto-backup: {_formatRelative(scheduleCfg.lastAutoRun)}</span>
                  </div>
                {/if}
                {#if _nextDueLabel(scheduleCfg)}
                  <div class="auto-bk-status-row">
                    <span class="material-symbols-rounded" style="font-size:16px">schedule</span>
                    <span>Next: {_nextDueLabel(scheduleCfg)}</span>
                  </div>
                {/if}
                {#if scheduleCfg.retention}
                  <div class="auto-bk-status-row subtle">
                    Keeps the {scheduleCfg.retention} newest backup{scheduleCfg.retention === 1 ? '' : 's'}; older archives prune automatically after each run.
                  </div>
                {/if}
              </div>
            {/if}
          </div>
          <div class="setting-divider" style="margin:0 -16px 12px"></div>
        {/if}

        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          <button class="btn btn-primary" style="height:36px;font-size:13px"
            on:click={createFullBackup} disabled={fullBackupBusy}>
            {#if fullBackupBusy}
              <span class="material-symbols-rounded spin" style="font-size:16px">autorenew</span> Working…
            {:else}
              <span class="material-symbols-rounded" style="font-size:16px">add_circle</span> Create Backup
            {/if}
          </button>
          <button class="btn btn-secondary" style="height:36px;font-size:13px"
            on:click={pickUploadRestore} disabled={fullBackupBusy}>
            <span class="material-symbols-rounded" style="font-size:16px">upload</span> Upload &amp; Restore
          </button>
        </div>
        {#if restoreStatus}
          <div class="restore-progress" transition:slide={{ duration: 160 }}>
            <div class="restore-progress-label">
              <span class="material-symbols-rounded spin" style="font-size:15px;flex-shrink:0">autorenew</span>
              {restoreStatus.label}
            </div>
            <div class="restore-progress-track">
              <div class="restore-progress-fill" style="width:{restoreStatus.percent}%"></div>
            </div>
          </div>
        {/if}
        <input bind:this={uploadInput} type="file" accept=".zip,application/zip" on:change={onUploadFile} style="display:none" />
      </div>

      {#if fullBackups.length > 0}
        <div class="setting-divider"></div>
        <div class="backup-table-header">
          <span>{$_('backup_page.col_name')}</span>
          <span>{$_('backup_page.col_created')}</span>
          <span>{$_('backup_page.col_size')}</span>
          <span></span>
        </div>
        <div class="setting-divider"></div>
        {#each fullBackups as bk, i (bk.filename)}
          {#if i > 0}<div class="setting-divider"></div>{/if}
          <div class="backup-row">
            <span class="backup-name">{bk.filename}</span>
            <span class="backup-col-date">{new Date(bk.createdAt).toLocaleDateString()}</span>
            <span class="backup-col-size">{fmtBytes(bk.size)}</span>
            <div class="backup-actions">
              <button class="btn btn-secondary backup-action-btn" on:click={() => downloadFullBackup(bk.filename)}>
                <span class="material-symbols-rounded" style="font-size:15px">download</span> Download
              </button>
              <button class="btn btn-secondary backup-action-btn"
                on:click={() => restoreFullBackup(bk.filename)} disabled={fullBackupBusy}>
                <span class="material-symbols-rounded" style="font-size:15px">restore</span> Restore
              </button>
              <button class="btn-icon" style="color:var(--danger);padding:0 4px"
                on:click={() => deleteFullBackup(bk.filename)} title="Delete backup" aria-label="Delete backup">
                <span class="material-symbols-rounded" style="font-size:20px">delete</span>
              </button>
            </div>
          </div>
        {/each}
      {:else}
        <div class="setting-divider"></div>
        <p style="padding:12px 16px;font-size:13px;color:var(--text-3);margin:0">
          No backups yet. Click Create Backup to get started.
        </p>
      {/if}
    </div>
  {/if}

  <!-- ── LOCAL FULL BACKUP (Android local mode) ───────────────────── -->
  <!-- On native local mode there's no server to run the full-backup
       ZIP route, so we produce the same shape on-device: every table
       + every image file zipped into one archive, shared via the
       Android share sheet. -->
  {#if isNative && !serverEnabled}
    <p class="settings-group-heading">{$_('backup_page.full_backup')}</p>
    <p class="settings-group-sub">{$_('backup_page.full_backup_sub_local')}</p>
    <div class="card settings-card">
      <div style="padding:12px 16px 4px">
        <p class="setting-desc" style="margin:0 0 12px">{$_('backup_page.full_backup_desc_local')}</p>
        {#if localScheduleCfg}
          <div class="auto-bk">
            <div class="auto-bk-head">
              <span class="auto-bk-title">{$_('backup_page.auto_backup')}</span>
            </div>
            <div class="auto-bk-fields">
              <label class="auto-bk-field">
                <span class="auto-bk-label">{$_('backup_page.schedule')}</span>
                <select class="select sel-sm"
                  value={localScheduleCfg.schedule}
                  on:change={(e) => saveLocalSchedule({ schedule: e.target.value })}>
                  <option value="off">Off</option>
                  <option value="daily">{$_('backup_page.daily')}</option>
                  <option value="weekly">{$_('backup_page.weekly')}</option>
                  <option value="monthly">{$_('backup_page.monthly')}</option>
                </select>
              </label>
              {#if localScheduleCfg.schedule !== 'off'}
                <label class="auto-bk-field">
                  <span class="auto-bk-label">{$_('backup_page.time')}</span>
                  <TimePicker value={localScheduleCfg.time}
                    on:change={(e) => saveLocalSchedule({ time: e.detail })} />
                </label>
                <label class="auto-bk-field">
                  <span class="auto-bk-label">{$_('backup_page.keep_last')}</span>
                  <input class="input" type="number" min="1" max="99"
                    value={localScheduleCfg.retention}
                    on:change={(e) => saveLocalSchedule({ retention: e.target.value })} />
                </label>
              {/if}
            </div>
            {#if localScheduleCfg.schedule !== 'off'}
              <div class="auto-bk-status">
                {#if localScheduleCfg.lastAutoError}
                  <div class="auto-bk-status-row error">
                    <span class="material-symbols-rounded" style="font-size:16px">error</span>
                    <span>Last auto-backup failed: {localScheduleCfg.lastAutoError}</span>
                  </div>
                {/if}
                {#if localScheduleCfg.lastAutoRun}
                  <div class="auto-bk-status-row">
                    <span class="material-symbols-rounded" style="font-size:16px">check_circle</span>
                    <span>Last auto-backup: {_formatRelative(localScheduleCfg.lastAutoRun)}</span>
                  </div>
                {/if}
                {#if _nextDueLabel(localScheduleCfg)}
                  <div class="auto-bk-status-row">
                    <span class="material-symbols-rounded" style="font-size:16px">schedule</span>
                    <span>Next: {_nextDueLabel(localScheduleCfg)} (fires when app is open)</span>
                  </div>
                {/if}
                <div class="auto-bk-status-row subtle">
                  Keeps the {localScheduleCfg.retention} newest auto-backup{localScheduleCfg.retention === 1 ? '' : 's'}; manual exports are never pruned.
                </div>
              </div>
            {/if}
          </div>
          <div class="setting-divider" style="margin:0 -16px 12px"></div>
        {/if}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          <button class="btn btn-primary" style="height:36px;font-size:13px" on:click={exportLocalZipBackup} disabled={localBackupBusy}>
            {#if localBackupBusy}
              <span class="material-symbols-rounded spin" style="font-size:16px">autorenew</span> {$_('backup_page.working')}
            {:else}
              <span class="material-symbols-rounded" style="font-size:16px">add_circle</span> {$_('backup_page.create')}
            {/if}
          </button>
          <button class="btn btn-secondary" style="height:36px;font-size:13px" on:click={importLocalZipBackup} disabled={localBackupBusy}>
            <span class="material-symbols-rounded" style="font-size:16px">upload</span> {$_('backup_page.upload_restore')}
          </button>
        </div>
        {#if localZipStatus}
          <div class="restore-progress" transition:slide={{ duration: 160 }}>
            <div class="restore-progress-label">
              <span class="material-symbols-rounded spin" style="font-size:15px;flex-shrink:0">autorenew</span>
              {localZipStatus}
            </div>
          </div>
        {/if}
        <input bind:this={importZipInput} type="file" accept=".zip,application/zip" on:change={onImportZipFile} style="display:none" />
      </div>

      {#if localBackups.length > 0}
        <div class="setting-divider"></div>
        <div class="backup-table-header">
          <span>{$_('backup_page.col_name')}</span>
          <span>{$_('backup_page.col_created')}</span>
          <span>{$_('backup_page.col_size')}</span>
          <span></span>
        </div>
        <div class="setting-divider"></div>
        {#each localBackups as bk, i (bk.filename)}
          {#if i > 0}<div class="setting-divider"></div>{/if}
          <div class="backup-row">
            <span class="backup-name">{bk.filename}</span>
            <span class="backup-col-date">{new Date(bk.createdAt).toLocaleDateString()}</span>
            <span class="backup-col-size">{fmtBytes(bk.size)}</span>
            <div class="backup-actions">
              <button class="btn btn-secondary backup-action-btn" on:click={() => shareLocalBackup(bk.filename)}>
                <span class="material-symbols-rounded" style="font-size:15px">share</span> {$_('backup_page.share')}
              </button>
              <button class="btn btn-secondary backup-action-btn" on:click={() => restoreLocalBackup(bk.filename)} disabled={localBackupBusy}>
                <span class="material-symbols-rounded" style="font-size:15px">restore</span> {$_('backup_page.restore')}
              </button>
              <button class="btn-icon" style="color:var(--danger);padding:0 4px" on:click={() => deleteLocalBackup(bk.filename)} title={$_('backup_page.delete_title')} aria-label={$_('backup_page.delete_title')}>
                <span class="material-symbols-rounded" style="font-size:20px">delete</span>
              </button>
            </div>
          </div>
        {/each}
      {:else}
        <div class="setting-divider"></div>
        <p style="padding:12px 16px;font-size:13px;color:var(--text-3);margin:0">{$_('backup_page.empty_local')}</p>
      {/if}
    </div>
  {/if}

  <!-- ── PORTABLE JSON EXPORT ─────────────────────────────────────── -->
  <p class="settings-group-heading">{$_('backup_page.portable_json')}</p>
  <p class="settings-group-sub">{$_('backup_page.portable_json_sub')}</p>
  <div class="card settings-card">
    <button class="setting-row setting-action" on:click={exportBackup}>
      <span class="material-symbols-rounded si" style="color:var(--accent)">download</span>
      <div>
        <span class="setting-label">{$_('backup_page.export_json')}</span>
        <div class="setting-desc">Lighter format: JSON only, no images. Useful for sharing data between accounts or quick text-based exports.</div>
      </div>
      <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
    </button>
    <div class="setting-divider"></div>
    <button class="setting-row setting-action" on:click={importBackup}>
      <span class="material-symbols-rounded si" style="color:var(--accent)">upload</span>
      <div>
        <span class="setting-label">{$_('backup_page.import_json')}</span>
        <div class="setting-desc">Restores from a previously exported JSON file. Merges with existing data and does not erase what's already here.</div>
      </div>
      <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
    </button>
    <input bind:this={importJsonInput} type="file" accept=".json,application/json" on:change={onImportJsonFile} style="display:none" />
  </div>

  <!-- ── DANGER ZONE ─────────────────────────────────────────────────── -->
  <p class="settings-group-heading danger-zone-label">{$_('backup_page.danger_zone')}</p>
  <p class="settings-group-sub">{$_('backup_page.danger_zone_sub')}</p>
  <div class="card settings-card danger-zone-card">
    <button class="setting-row setting-action" on:click={_confirmClearAllData}>
      <span class="material-symbols-rounded si" style="color:var(--danger);background:color-mix(in srgb,var(--danger) 14%,transparent)">delete_forever</span>
      <div>
        <span class="setting-label" style="color:var(--danger)">{$_('backup_page.clear_all_data')}</span>
        <div class="setting-desc">Permanently deletes all notes. Settings and credentials are kept.</div>
      </div>
      <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger);flex-shrink:0">chevron_right</span>
    </button>
    <div class="setting-divider"></div>
    <button class="setting-row setting-action" on:click={_confirmClearAllSettings}>
      <span class="material-symbols-rounded si" style="color:var(--danger);background:color-mix(in srgb,var(--danger) 14%,transparent)">manage_history</span>
      <div>
        <span class="setting-label" style="color:var(--danger)">{$_('backup_page.clear_all_settings')}</span>
        <div class="setting-desc">Resets all preferences, credentials, and API keys to defaults. Notes and other data are kept.</div>
      </div>
      <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger);flex-shrink:0">chevron_right</span>
    </button>
  </div>
</div>

<style>
  /* Auto Backup schedule block — TraceApps parity with NT's
     SettingsBackup. Same classes + values; mirror changes across both. */
  .auto-bk { display: flex; flex-direction: column; gap: 10px; padding: 10px 0 14px; }
  .auto-bk-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px;
  }
  .auto-bk-title {
    font-size: 13px; font-weight: 600; color: var(--text-1);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .env-lock-pill {
    font-size: 11px; font-weight: 600;
    padding: 2px 8px;
    background: var(--surface-2); color: var(--text-3);
    border: 1px solid var(--border); border-radius: 999px;
  }
  .auto-bk-fields { display: flex; flex-wrap: wrap; gap: 10px; }
  .auto-bk-field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; min-width: 110px; }
  .auto-bk-label { font-size: 11px; color: var(--text-3); font-weight: 500; }
  .auto-bk-field .input, .auto-bk-field .select { width: 100%; }
  .auto-bk-field :global(.tp-trigger) {
    width: 100%; justify-content: space-between; height: 36px;
  }
  .auto-bk-status {
    display: flex; flex-direction: column; gap: 4px;
    padding: 8px 12px;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    font-size: 12px; color: var(--text-2);
  }
  .auto-bk-status-row { display: flex; align-items: center; gap: 6px; }
  .auto-bk-status-row.subtle { color: var(--text-3); font-size: 11.5px; }
  .auto-bk-status-row.error  { color: var(--danger); }

  /* Layout matches NutriTrace SettingsBackup verbatim. The selectors
     below mirror NT's class names + values exactly. */


  .card.settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .setting-row {
    display: flex; align-items: center; gap: 12px;
    padding: 13px 16px; min-height: 50px;
  }
  .setting-row > div { flex: 1; min-width: 0; }
  .setting-label { font-size: 14px; font-weight: 500; color: var(--text-1); display: block; }
  .setting-desc { font-size: 12px; color: var(--text-3); margin-top: 2px; line-height: 1.4; display: block; font-weight: 400; word-break: break-word; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }

  .si {
    font-size: 18px;
    flex-shrink: 0;
    width: 30px; height: 30px;
    background: var(--accent-dim);
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
  }

  .setting-action {
    width: 100%; background: none; border: none; cursor: pointer;
    color: var(--text-1); text-align: left;
    transition: background var(--dur-fast);
  }
  .setting-action:hover  { background: var(--surface-2); }
  .setting-action:active { background: var(--surface-3, var(--surface-2)); }

  .restore-progress {
    padding: 0 0 14px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .restore-progress-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; color: var(--text-2);
  }
  .restore-progress-track {
    height: 6px; border-radius: 3px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .restore-progress-fill {
    height: 100%; border-radius: 3px;
    background: var(--accent);
    transition: width 300ms ease;
  }
  .spin { animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .backup-table-header {
    display: grid;
    grid-template-columns: 1fr 100px 80px auto;
    gap: 12px; padding: 6px 16px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
  }
  .backup-row {
    display: grid;
    grid-template-columns: 1fr 100px 80px auto;
    gap: 12px; padding: 10px 16px;
    align-items: center;
  }
  .backup-name {
    font-size: 12px; font-weight: 500; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .backup-col-date { font-size: 13px; color: var(--text-2); }
  .backup-col-size { font-size: 13px; color: var(--text-2); }
  .backup-actions { display: flex; align-items: center; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
  .backup-action-btn { height: 30px; font-size: 12px; padding: 0 10px; display: flex; align-items: center; gap: 4px; }

  @media (max-width: 480px) {
    .backup-table-header { display: none; }
    .backup-row {
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto;
      row-gap: 6px;
    }
    .backup-name { grid-column: 1; grid-row: 1; }
    .backup-col-date { grid-column: 1; grid-row: 2; font-size: 12px; }
    .backup-col-size { display: none; }
    .backup-actions { grid-column: 2; grid-row: 1 / 3; flex-direction: column; align-items: stretch; }
    .backup-action-btn { justify-content: center; }
  }

  .btn-icon {
    background: transparent; border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .btn-icon:hover { opacity: 0.8; }

  /* Danger Zone — same card scaffolding, accent color shifted to
     --danger so the destructive section reads as distinct from the
     normal Backup / Export rows above. */
  .danger-zone-label { color: var(--danger) !important; opacity: 0.85; }
  .danger-zone-card { border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
</style>
