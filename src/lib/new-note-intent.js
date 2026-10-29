/**
 * new-note-intent.js: a new note the app itself asked for.
 *
 * The Android home screen shortcuts and the Quick Note widget open
 * notetrace://new/<kind> with explicit intents; no web page can open that
 * link, since it isn't in the app's browsable deep links. App.svelte marks
 * such a request here before it goes to /?new=<kind>, and only a marked voice
 * note starts recording at once. The same address reached any other way (a
 * link to the web app) opens the recorder waiting for a tap on Record.
 */
let _asked = null;

export function markAppNewNote(kind) { _asked = { kind, at: Date.now() }; }

/** True once, for the kind App.svelte just marked (within a few seconds). */
export function takeAppNewNote(kind, now = Date.now()) {
  const a = _asked;
  _asked = null;
  return !!a && a.kind === kind && now - a.at < 5000;
}

// A shortcut or widget that starts the app arrives twice on Android: as the
// launch URL and as appUrlOpen. The second within a few seconds is the same tap.
let _last = null;
/** The route for a new note of this kind, or null for a repeat of the one just sent. */
export function newNoteRoute(kind, now = Date.now()) {
  if (!kind) return null;
  if (_last && _last.kind === kind && now - _last.at < 3000) return null;
  _last = { kind, at: now };
  return `/?new=${encodeURIComponent(kind)}`;
}

// The launch URL stays the same for as long as the app runs, through every
// page reload (signing out, restoring a backup): only the first page that
// reads it opens it. sessionStorage lasts through a reload and starts empty
// in a new start of the app; a fresh start brings the link again anyway.
const LAUNCH_KEY = 'note:launchNewNoteRead';
/** True the first time this page session reads the launch URL's shortcut. */
export function firstLaunchRead(store = globalThis.sessionStorage) {
  try {
    if (store?.getItem(LAUNCH_KEY)) return false;
    store?.setItem(LAUNCH_KEY, '1');
  } catch {}
  return true;
}
