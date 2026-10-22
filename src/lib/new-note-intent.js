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
