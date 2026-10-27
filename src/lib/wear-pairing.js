/**
 * wear-pairing.js: hand the watch app what it needs to reach the server.
 *
 * The Wear app talks to NoteTrace itself, so it works with the phone out of
 * range. It needs the server address and a token for the signed-in account,
 * and there is no keyboard on a watch worth typing either into. The phone
 * writes both into the Wearable Data Layer when you sign in, and takes them
 * away when you sign out.
 *
 * Android only, and only when a watch is actually paired with this phone.
 */
import { registerPlugin } from '@capacitor/core';
import { isNative, getServerUrl, getAuthToken } from './platform.js';
import { APP_VERSION } from './version.js';
import { mirroredConfirmation } from './plain-http.js';

// Registered at module level: a plugin proxy returned from an async function
// confuses Capacitor's promise handling.
const WearPairing = registerPlugin('WearPairing');

/** Is there a watch paired with this phone? */
export async function hasWatch() {
  if (!isNative) return false;
  try {
    const { paired } = await WearPairing.hasWatch();
    return !!paired;
  } catch {
    return false;
  }
}

/**
 * Send the current server and token to the watch. Safe to call often: the
 * write carries a timestamp, so a refreshed token still reaches the watch.
 */
export async function pairWatch() {
  if (!isNative) return false;
  const serverUrl = getServerUrl();
  const token = getAuthToken();
  if (!serverUrl || !token) return false;
  if (!(await hasWatch())) return false;
  try {
    // With this phone's release: a watch on an older one catches up to it.
    // httpOk: the server again when it is plain http:// on your own network
    // and you said Connect Anyway to it; the watch uses plain HTTP only then
    // (LocalAddress.kt, from TraceApps/nutritrace#194).
    await WearPairing.pair({ serverUrl, token, appVersion: APP_VERSION, httpOk: mirroredConfirmation(serverUrl) });
    return true;
  } catch {
    return false;
  }
}

/** Signed out: the watch shouldn't keep a working token. */
export async function unpairWatch() {
  if (!isNative) return false;
  try {
    await WearPairing.unpair();
    return true;
  } catch {
    return false;
  }
}
