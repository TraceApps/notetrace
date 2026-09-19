/**
 * biometric.js — fingerprint / face unlock for Android server-mode login.
 *
 * Mirrors the NutriTrace and LiftTrace implementations for TraceApps
 * uniformity. Threat model + lifecycle are identical: biometric is a UX
 * layer that gates an at-rest-encrypted JWT in Capacitor Preferences,
 * not an added security boundary.
 *
 * Lifecycle:
 *   - Settings toggle 'biometricLoginEnabled' lights up after first
 *     successful password login (so a user always has to enter a real
 *     password at least once before biometric can unlock the app).
 *   - On password-login success: when the toggle is on, saveTokenForBiometric()
 *     stashes the JWT in a localStorage key.
 *   - On app open with a saved token: Login.svelte offers a biometric
 *     button. Tapping runs authenticate() → on success readSavedToken().
 *   - On logout / 401 / expired-token bounce: clearSavedToken() wipes the
 *     stash so the next biometric tap doesn't loop on a dead token.
 *
 * Local-only mode (no server) and PWA both no-op these helpers since
 * neither has a JWT-style auth flow that benefits from biometric unlock.
 */

import { Capacitor } from '@capacitor/core';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { isNative, getServerUrl } from './platform.js';

// NB: The Capacitor plugin import has to be STATIC. Dynamic import
// (`await import('...')`) silently fails to resolve the native bridge on
// Android in production builds.
const TOKEN_KEY = 'note:biometric:token';

function _getPlugin() {
  if (!Capacitor.isNativePlatform()) return null;
  return BiometricAuth || null;
}

/** Whether the device hardware supports biometric auth at all. */
export async function isAvailable() {
  const info = await getStatus();
  return !!info?.isAvailable;
}

/** Detailed status — distinguishes "no hardware" from "not enrolled". Used
 *  by the Settings toggle to surface the actual reason the user can't enable
 *  biometric (e.g. "Set up fingerprint in Android Settings first"). */
export async function getStatus() {
  if (!isNative) return { isAvailable: false, reason: 'PWA — biometric is Android-only', code: 'web' };
  const p = _getPlugin();
  if (!p) return { isAvailable: false, reason: 'Biometric plugin unavailable', code: 'noPlugin' };
  try {
    const info = await p.checkBiometry();
    return {
      isAvailable: !!info?.isAvailable,
      reason: info?.reason || '',
      code: info?.code || '',
      biometryType: info?.biometryType || '',
    };
  } catch (e) {
    return { isAvailable: false, reason: e?.message || 'Probe failed', code: 'error' };
  }
}

/** Trigger the OS biometric prompt. Returns true on success, false on cancel/fail. */
export async function authenticate(reason = 'Sign in to NoteTrace') {
  const p = _getPlugin();
  if (!p) return false;
  try {
    await p.authenticate({
      reason,
      cancelTitle: 'Use Password',
      androidTitle: 'NoteTrace',
      androidSubtitle: reason,
      androidConfirmationRequired: false,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Unlock prompt for the app lock. Falls back to the device PIN, pattern, or
 * password, so a changed fingerprint enrollment can never lock someone out
 * of their own notes.
 */
export async function authenticateUnlock(reason) {
  const p = _getPlugin();
  if (!p) return false;
  try {
    await p.authenticate({
      reason,
      androidTitle: 'NoteTrace',
      androidSubtitle: reason,
      androidConfirmationRequired: false,
      allowDeviceCredential: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Save the JWT for the current session so the next launch can unlock with biometric. */
export async function saveTokenForBiometric(token) {
  if (!isNative || !getServerUrl() || !token) return;
  localStorage.setItem(TOKEN_KEY, token);
}

/** Read the saved token (no biometric prompt — call authenticate() first). */
export async function readSavedToken() {
  if (!isNative) return null;
  return localStorage.getItem(TOKEN_KEY) || null;
}

/** Wipe any saved token. Called on logout / disable toggle / auth failure. */
export async function clearSavedToken() {
  localStorage.removeItem(TOKEN_KEY);
}
