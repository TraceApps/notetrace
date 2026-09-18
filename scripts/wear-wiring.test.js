/**
 * wear-wiring.test.js: the watch app and the phone half of pairing stay wired.
 *
 * The Wear module is Kotlin, so these are text checks on the things that break
 * silently: the signing that lets the Data Layer carry anything at all, the
 * standalone flag, and the slim endpoint the watch depends on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('the watch app is signed with the phone\'s key', () => {
  // The Wearable Data Layer only moves data between apps with the same package
  // and the same certificate. The phone's debug build uses the release key, so
  // the watch must too, or pairing silently carries nothing.
  const wear = read('android/wear/build.gradle');
  assert.match(wear, /applicationId "com\.notetrace\.app"/);
  assert.match(wear, /debug \{[\s\S]*?signingConfig signingConfigs\.release/);
  assert.match(wear, /release \{[\s\S]*?signingConfig signingConfigs\.release/);
});

test('the watch runs without the phone', () => {
  const manifest = read('android/wear/src/main/AndroidManifest.xml');
  assert.match(manifest, /com\.google\.android\.wearable\.standalone"\s*\n?\s*android:value="true"/);
  assert.match(manifest, /uses-feature android:name="android\.hardware\.type\.watch"/);
  assert.match(manifest, /android\.permission\.INTERNET/);
  // The pairing service listens on the path the phone writes to.
  assert.match(manifest, /pathPrefix="\/notetrace"/);
});

test('the phone hands over the link, and takes it back on sign-out', () => {
  const plugin = read('android/app/src/main/java/com/notetrace/app/WearPairingPlugin.java');
  assert.match(plugin, /@CapacitorPlugin\(name = "WearPairing"\)/);
  assert.match(plugin, /PutDataMapRequest\.create\("?\/notetrace\/pairing"?\)|PutDataMapRequest\.create\(PATH\)/);
  assert.match(plugin, /deleteDataItems/);
  assert.match(read('android/app/src/main/java/com/notetrace/app/MainActivity.java'), /registerPlugin\(WearPairingPlugin\.class\)/);
  const js = read('src/lib/wear-pairing.js');
  assert.match(js, /registerPlugin\('WearPairing'\)/);
  // Registered at module level, before any function: returning a plugin proxy
  // from an async function breaks Capacitor's promise handling.
  assert.ok(js.indexOf("registerPlugin('WearPairing')") < js.indexOf('export async function'),
    'registerPlugin must run at module level, not inside a function');
  assert.match(read('src/stores/auth.js'), /unpairWatch/);
});

test('the watch asks for the slim list, and the server can answer it', () => {
  const api = read('android/wear/src/main/java/com/notetrace/app/wear/NoteApi.kt');
  assert.match(api, /\/api\/notes\?slim=1/);
  assert.match(api, /\/api\/notes\?view=reminders&slim=1/);
  assert.match(api, /\/api\/integrations\/cooktrace\/shopping/);
  const route = read('server/routes/notes.js');
  assert.match(route, /req\.query\.slim === '1'/);
  // Slim carries what the watch draws: items, an excerpt, and reminder times.
  for (const field of ['items', 'excerpt', 'reminder_at']) {
    assert.ok(route.includes(`${field}:`), `slim is missing ${field}`);
  }
});

test('a spoken note is recognised by the system, and waits when offline', () => {
  const ui = read('android/wear/src/main/java/com/notetrace/app/wear/MainActivity.kt');
  // The system recogniser does the listening, so the app records nothing, needs
  // no microphone permission, and follows the watch's own language.
  assert.match(ui, /RecognizerIntent\.ACTION_RECOGNIZE_SPEECH/);
  assert.match(ui, /store\.addSpokenNote/);
  assert.doesNotMatch(read('android/wear/src/main/AndroidManifest.xml'), /RECORD_AUDIO/);
  // Said with no connection: it queues rather than vanishing.
  const pairing = read('android/wear/src/main/java/com/notetrace/app/wear/Pairing.kt');
  assert.match(pairing, /fun note\(text: String\)/);
  const store = read('android/wear/src/main/java/com/notetrace/app/wear/WearStore.kt');
  assert.match(store, /"note" -> NoteApi\.createNote/);
  // Two spoken notes are two notes: only ticks collapse in the outbox.
  assert.match(pairing, /if \(op\.kind in adds\) outbox\(ctx\)/);
});

test('the complication reads the snapshot and is redrawn when it changes', () => {
  const manifest = read('android/wear/src/main/AndroidManifest.xml');
  assert.match(manifest, /BIND_COMPLICATION_PROVIDER/);
  assert.match(manifest, /SUPPORTED_TYPES"\s*\n?\s*android:value="SHORT_TEXT"/);
  const comp = read('android/wear/src/main/java/com/notetrace/app/wear/ListComplicationService.kt');
  assert.match(comp, /Pairing\.cache\(this\)/);
  assert.doesNotMatch(comp, /NoteApi\./);
  assert.match(read('android/wear/src/main/java/com/notetrace/app/wear/WearStore.kt'), /ListComplicationService\.refresh\(ctx\)/);
});

test('anything added or finished on the watch survives no connection', () => {
  const store = read('android/wear/src/main/java/com/notetrace/app/wear/WearStore.kt');
  // Every action queues first and sends second, so none of them need a network.
  for (const kind of ['"note"', '"add_item"', '"add_shopping"', '"reminder_done"']) {
    assert.ok(store.includes(kind + ' ->'), `the outbox can't send ${kind}`);
  }
  const pairing = read('android/wear/src/main/java/com/notetrace/app/wear/Pairing.kt');
  for (const fn of ['fun note(', 'fun newItem(', 'fun newShopping(', 'fun reminderDone(']) {
    assert.ok(pairing.includes(fn), `${fn} is missing from the outbox`);
  }
  // Adds never collapse into each other; two spoken items are two items.
  assert.match(pairing, /val adds = setOf\("note", "add_item", "add_shopping"\)/);
});

test('the tile is registered and draws from the saved snapshot', () => {
  const manifest = read('android/wear/src/main/AndroidManifest.xml');
  assert.match(manifest, /androidx\.wear\.tiles\.action\.BIND_TILE_PROVIDER/);
  assert.match(manifest, /BIND_TILE_PROVIDER"/);
  const tile = read('android/wear/src/main/java/com/notetrace/app/wear/ListTileService.kt');
  // No network on the tile path: it reads what the app already saved.
  assert.match(tile, /Pairing\.cache\(this\)/);
  assert.doesNotMatch(tile, /NoteApi\./);
  // And the app asks for a redraw when that snapshot changes.
  assert.match(read('android/wear/src/main/java/com/notetrace/app/wear/WearStore.kt'), /ListTileService\.refresh\(ctx\)/);
});

test('a reminder notification carries icons for its actions', () => {
  // On a watch, an action without an icon shows as an empty circle.
  const receiver = read('android/app/src/main/java/com/notetrace/app/NoteReminderReceiver.java');
  assert.match(receiver, /addAction\(R\.drawable\.ic_action_done/);
  assert.match(receiver, /addAction\(R\.drawable\.ic_action_snooze/);
  for (const icon of ['ic_action_done.xml', 'ic_action_snooze.xml']) {
    assert.ok(fs.existsSync(path.join(root, 'android/app/src/main/res/drawable', icon)), `${icon} is missing`);
  }
});
