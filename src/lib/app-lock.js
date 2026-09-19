/**
 * app-lock.js: optional biometric lock for the Android app.
 *
 * When enabled, the app opens locked and re-locks after it has been in
 * the background longer than the chosen timeout. The lock covers the UI
 * only; it isn't encryption (Android's file-based encryption already
 * protects data at rest on a locked phone).
 */
import { writable, get } from 'svelte/store';
import { isNative } from './platform.js';
import { appLockEnabled, appLockTimeoutMin } from '../stores/settings.js';

// Start locked (before the first paint) when the lock is on, so notes never flash.
export const appLocked = writable(isNative && !!get(appLockEnabled));

let _started = false;
let _backgroundAt = null;
// The device-credential screen is its own activity, so the app briefly
// "backgrounds" while the user unlocks. Those transitions are ignored.
let _authenticating = false;

export function setAuthenticating(v) {
  _authenticating = !!v;
  if (!v) _backgroundAt = null;
}

export async function startAppLock() {
  if (!isNative || _started) return;
  _started = true;
  try {
    const { App } = await import('@capacitor/app');
    App.addListener('appStateChange', ({ isActive }) => {
      if (!get(appLockEnabled) || _authenticating || get(appLocked)) return;
      if (!isActive) {
        _backgroundAt = Date.now();
        return;
      }
      if (!_backgroundAt) return;
      const away = Date.now() - _backgroundAt;
      _backgroundAt = null;
      if (away >= Math.max(0, Number(get(appLockTimeoutMin)) || 0) * 60000) appLocked.set(true);
    });
  } catch (e) {
    console.warn('[app-lock] lifecycle listener unavailable:', e?.message || e);
  }
}

export function unlockApp() {
  appLocked.set(false);
}
