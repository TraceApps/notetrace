/**
 * wear-pairing.js: hand the watch app what it needs to reach the server.
 *
 * The Wear app talks to NoteTrace itself, so it works with the phone out of
 * range. It needs the server address and a token for the signed-in account,
 * and there is no keyboard on a watch worth typing either into. The phone
 * writes both into the Wearable Data Layer when you sign in, and takes them
 * away when you sign out. In Local mode there is no server: the watch asks
 * this phone instead (watch-relay.js).
 *
 * Android only, and only when a watch is actually paired with this phone.
 */
import { registerPlugin } from '@capacitor/core';
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { isNative, getServerUrl, getAuthToken, getNativeMode } from './platform.js';
import { APP_VERSION } from './version.js';
import { mirroredConfirmation } from './plain-http.js';
import { PHONE_ADDRESS, answerWatchRequest } from './watch-relay.js';

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
  const local = isLocalMode();
  // Signed out of a server: nothing to hand over.
  if (!local && (!serverUrl || !token)) return false;
  if (!(await hasWatch())) return false;
  try {
    // With this phone's release: a watch on an older one catches up to it.
    // httpOk: the server again when it is plain http:// on your own network
    // and you said Connect Anyway to it; the watch uses plain HTTP only then
    // (LocalAddress.kt, from TraceApps/nutritrace#194).
    // In Local mode the watch is told to ask this phone instead (watch-relay.js).
    if (local) await WearPairing.pair({ serverUrl: PHONE_ADDRESS, token: 'local', appVersion: APP_VERSION, httpOk: '' });
    else await WearPairing.pair({ serverUrl, token, appVersion: APP_VERSION, httpOk: mirroredConfirmation(serverUrl) });
    return true;
  } catch {
    return false;
  }
}

/** Local mode: no server, so the watch asks this phone (watch-relay.js). */
export function isLocalMode() {
  return isNative && getNativeMode() === 'local' && !getServerUrl();
}

let _serving = false;

/**
 * Answer the watch's requests in Local mode (watch-relay.js). Listening in
 * any native mode costs nothing: a phone connected to a server answers that
 * the watch should pair again, which it does with the server's address.
 */
export function serveWatch() {
  if (!isNative || _serving) return;
  _serving = true;
  try {
    WearPairing.addListener('watchRequest', async (req) => {
      let out;
      try {
        const [{ NoteApiNative }, { DB }] = await Promise.all([import('./api-native.js'), import('./db.js')]);
        out = await answerWatchRequest(req, {
          localMode: isLocalMode(),
          api: NoteApiNative,
          watchNotes: () => DB.getSetting('watchNotes', []),
        });
      } catch (e) {
        out = { status: 500, body: JSON.stringify({ error: e?.message || 'The phone could not answer' }) };
      }
      try { await WearPairing.answer({ id: String(req?.id || ''), status: out.status, body: out.body }); } catch { /* the watch gave up */ }
      // The screens, reminders and widget follow, as after any change.
      if (out.changed) {
        try { (await import('../stores/notes.js')).signalNotesChanged(); } catch { /* no screens */ }
      }
    });
  } catch { /* no watch here */ }
}

/**
 * Keep the app awake for the watch while it's off screen (on), or not (off).
 * Local mode only, and only with a watch connected or used lately.
 */
export async function keepAwakeForWatch(on) {
  if (!isNative) return;
  try {
    if (on && isLocalMode()) await WearPairing.keepAwake({ on: true, title: 'NoteTrace', text: get(_)('watch.keep_awake_text') });
    else await WearPairing.keepAwake({ on: false });
  } catch { /* no watch here */ }
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
