/**
 * local-backup-scheduler.js — fire scheduled local backups while
 * NoteTrace is open in local Android mode. Mirrors NutriTrace's
 * implementation 1:1 for TraceApps parity; only the filename prefix
 * and the JSZip caller name differ.
 *
 * Same trade-off as NT: JS-side tick (not WorkManager) because users
 * open the app to plan / log cooks at least once per cadence. Manual
 * exports + Android's default app-data autobackup cover the "never
 * opens the app" edge case.
 *
 * Storage:
 *   - Auto backups: Documents/notetrace-backups/notetrace-backup-auto-<ts>.zip
 *     (the manual exportLocalZip path uses @capacitor/share so manual
 *     archives don't live in this folder — separate destinations, no
 *     collision; retention only touches files we wrote here.)
 *
 * Settings: localBackupSchedule / Time / Retention / LastRun / LastError
 */
import { isNative, getNativeMode } from './platform.js';
import {
  localBackupSchedule, localBackupTime, localBackupRetention,
  localBackupLastRun, localBackupLastError,
} from '../stores/settings.js';

const INTERVAL_MS = {
  daily:   22 * 60 * 60 * 1000,
  weekly:  6.5 * 24 * 60 * 60 * 1000,
  monthly: 28 * 24 * 60 * 60 * 1000,
};

const AUTO_PREFIX = 'notetrace-backup-auto-';
const BACKUP_DIR  = 'notetrace-backups';
const TICK_MS = 5 * 60 * 1000;

let _timer = null;
let _running = false;

function _isLocalMode() {
  return !!(isNative && getNativeMode() === 'local');
}

export function startLocalBackupScheduler() {
  if (_timer) return;
  if (!_isLocalMode()) return;
  setTimeout(_tick, 5_000);
  _timer = setInterval(_tick, TICK_MS);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', _onVisibility);
  }
}

export function stopLocalBackupScheduler() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _onVisibility);
  }
}

function _onVisibility() {
  if (document.visibilityState === 'visible') {
    setTimeout(_tick, 1_000);
  }
}

async function _tick() {
  if (_running) return;
  if (!_isLocalMode()) return;

  const schedule = localBackupSchedule.get();
  if (schedule === 'off') return;
  const intervalMs = INTERVAL_MS[schedule];
  if (!intervalMs) return;

  const timeStr = localBackupTime.get() || '03:00';
  const [hh, mm] = String(timeStr).split(':').map(n => parseInt(n, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;

  const now = new Date();
  const scheduledMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0).getTime();
  if (now.getTime() < scheduledMs) return;

  const last = localBackupLastRun.get();
  if (last) {
    const lastMs = new Date(last).getTime();
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < intervalMs) return;
  }

  await _runAutoBackup();
}

async function _runAutoBackup() {
  if (_running) return;
  _running = true;
  try {
    const { exportLocalZip } = await import('./local-backup.js');
    const blob = await exportLocalZip();
    const filename = `${AUTO_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`;
    await _writeBackupFile(filename, blob);
    await _pruneAutoBackups(parseInt(localBackupRetention.get(), 10) || 7);
    localBackupLastRun.set(new Date().toISOString());
    localBackupLastError.set('');
    console.log(`[local-backup] auto-backup saved: ${filename}`);
  } catch (e) {
    const msg = e?.message || String(e);
    localBackupLastError.set(msg);
    console.warn(`[local-backup] auto-backup failed: ${msg}`);
  } finally {
    _running = false;
  }
}

async function _writeBackupFile(filename, blob) {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  await Filesystem.mkdir({ path: BACKUP_DIR, directory: Directory.Documents, recursive: true }).catch(() => {});
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  const b64 = btoa(binary);
  await Filesystem.writeFile({
    path: `${BACKUP_DIR}/${filename}`,
    data: b64,
    directory: Directory.Documents,
  });
}

async function _pruneAutoBackups(retention) {
  const keep = Math.max(1, Math.min(99, parseInt(retention, 10) || 7));
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  try {
    const list = await Filesystem.readdir({ path: BACKUP_DIR, directory: Directory.Documents });
    const autos = (list.files || [])
      .filter(f => f.name && f.name.startsWith(AUTO_PREFIX) && f.name.endsWith('.zip'))
      .sort((a, b) => (b.name || '').localeCompare(a.name || ''));
    const toDelete = autos.slice(keep);
    for (const f of toDelete) {
      try {
        await Filesystem.deleteFile({ path: `${BACKUP_DIR}/${f.name}`, directory: Directory.Documents });
      } catch (e) {
        console.warn(`[local-backup] prune failed for ${f.name}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`[local-backup] prune list failed: ${e.message}`);
  }
}

export async function runLocalBackupNow() {
  if (!_isLocalMode()) throw new Error('Not in local mode');
  await _runAutoBackup();
}
