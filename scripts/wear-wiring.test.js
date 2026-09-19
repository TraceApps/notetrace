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
  assert.match(pairing, /fun note\(text: String/);
  const store = read('android/wear/src/main/java/com/notetrace/app/wear/WearStore.kt');
  assert.match(store, /"note" -> NoteApi\.createNote/);
  // Two spoken notes are two notes: only ticks collapse in the outbox.
  assert.match(pairing, /if \(op\.kind in adds\) outbox\(ctx\)/);
});

test('every list scrolls with the crown', () => {
  // A Pixel Watch scrolls by its crown; a plain ScalingLazyColumn only takes a
  // finger, which makes the app feel broken on hardware that has one.
  const ui = read('android/wear/src/main/java/com/notetrace/app/wear/MainActivity.kt');
  assert.match(ui, /rotaryScrollable\(RotaryScrollableDefaults\.behavior\(listState\)/);
  const built = (ui.match(/ScalingLazyColumn\(/g) || []).length;
  assert.equal(built, 1, 'CrownColumn should be the only place that builds a list, so no screen misses the crown');
  assert.match(ui, /private fun CrownColumn\(/);
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

test('a time said out loud sets the reminder instead of being written down', () => {
  const store = read('android/wear/src/main/java/com/notetrace/app/wear/WearStore.kt');
  assert.match(store, /SpokenTime\.parse\(clean\)/);
  // Worked out on the watch, so it still happens with no connection, and the
  // queued note carries the time it was meant to have.
  const pairing = read('android/wear/src/main/java/com/notetrace/app/wear/Pairing.kt');
  assert.match(pairing, /val at: String = ""/);
  assert.match(read('android/wear/src/main/java/com/notetrace/app/wear/NoteApi.kt'), /payload\.put\("reminder_at", reminderAt\)/);
  // The parser has its own tests, run by :wear:testDebugUnitTest.
  assert.ok(fs.existsSync(path.join(root, 'android/wear/src/test/java/com/notetrace/app/wear/SpokenTimeTest.kt')));
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

test('the watch list can be narrowed, and defaults to everything', () => {
  const route = read('server/routes/notes.js');
  // watch=1 filters to the chosen ids; with nothing chosen it stays the full list.
  assert.match(route, /req\.query\.watch === '1' \? watchChoice\(req\) : null/);
  assert.match(route, /const wanted = chosen \? notes\.filter\(n => chosen\.has\(n\.id\)\) : notes/);
  assert.match(route, /key = 'watchNotes'/);
  // Empty means everything, so the picker is optional.
  assert.match(route, /Array\.isArray\(ids\) && ids\.length \? new Set/);
  assert.match(read('android/wear/src/main/java/com/notetrace/app/wear/NoteApi.kt'), /slim=1&watch=1/);
  // The setting syncs, so a phone and a tablet agree about the watch.
  assert.match(read('src/stores/settings.js'), /'watchNotes'/);
  assert.match(read('src/components/settings/SettingsNotes.svelte'), /watchNotes\.set/);
});

test('a refused token asks for a re-pair instead of failing forever', () => {
  const store = read('android/wear/src/main/java/com/notetrace/app/wear/WearStore.kt');
  // 401 or 403 means the token died, which is a different problem from being
  // offline and needs a different answer on screen.
  assert.match(store, /fun isRefused\(e: Exception\)[\s\S]*?401, 403/);
  assert.match(store, /Pairing\.forget\(ctx\)/);
  // Queued work survives it: those edits are still good once a token arrives.
  assert.match(store, /if \(isRefused\(e\)\) \{[\s\S]*?return false/);
  const pairing = read('android/wear/src/main/java/com/notetrace/app/wear/Pairing.kt');
  // And the watch won't read the same dead token back off the phone.
  assert.match(pairing, /KEY_REFUSED/);
  assert.match(pairing, /if \(token == prefs\(ctx\)\.getString\(KEY_REFUSED, null\)\) continue/);
  assert.match(pairing, /\.remove\(KEY_REFUSED\)/);
});
