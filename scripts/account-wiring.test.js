/**
 * The Android app's account protection is wired where it has to be: every
 * sign-in ends at App.svelte's account check, signing out sends what's
 * waiting and stops what's running, Connect and Disconnect decide whose
 * the phone's data is, and Capacitor logs nothing (its plugin log carried
 * whole notes). The behavior itself is tested in android-sync.test.js.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('App.svelte shows nothing of the copy until the account check is ready', () => {
  const app = read('../src/App.svelte');
  assert.match(app, /ensureLocalAccount\(user, \{/);
  assert.match(app, /\{:else if !accountReady\}/);
  assert.match(app, /\$accountGate\.state === 'error'/);
  assert.match(app, /on:click=\{_checkAccount\}>\{\$_\('sync\.retry'\)\}/);
  assert.match(app, /\$: _settingsFor, reloadSettingStores\(\);/);
});

test('signing out sends what waits, then stops every run and resets what the app holds', () => {
  const auth = read('../src/stores/auth.js');
  assert.match(auth, /pushBeforeSignOut\(\)/);
  assert.match(auth, /la\.bumpAccountGeneration\(\);\s*\n\s*la\.resetAccountGate\(\);/);
  assert.match(auth, /resetUserState\(\)/);
  assert.match(auth, /tokenUserId\(getAuthToken\(\)\)/, "a cached account that isn't the session's is never shown");
});

test('Connect claims the copy for the account, Disconnect and local setup make it the phone\'s own', () => {
  assert.match(read('../src/components/settings/SettingsServerConnection.svelte'), /claimForServer\(_pendingServerUrl, _pendingUser\.id/);
  assert.match(read('../src/components/settings/SettingsServerConnection.svelte'), /setLocalOwner\(\)/);
  assert.match(read('../src/routes/NativeSetup.svelte'), /setLocalOwner\(\)/);
});

test('every sync goes through one run at a time, and every write checks the account', () => {
  const sync = read('../src/lib/sync.js');
  assert.match(sync, /if \(_syncInFlight\) \{ _syncAgain = true; return _syncInFlight; \}/);
  assert.match(sync, /_syncInFlight = promise;/);
  assert.ok(sync.indexOf('_syncInFlight = promise;') < sync.indexOf('async function _fullSync('), 'claimed before the first await');
  assert.match(sync, /localDataIsThisAccount\(token\)/);
  assert.match(read('../src/lib/db-native.js'), /if \(!live\(\)\) return false;/);
});

test('Capacitor logs nothing in any build', () => {
  assert.match(read('../capacitor.config.ts'), /loggingBehavior: 'none'/);
});

test('the install marker is kept out of every backup', () => {
  const manifest = read('../android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:fullBackupContent="@xml\/backup_rules"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  for (const f of ['backup_rules', 'data_extraction_rules']) {
    assert.match(read(`../android/app/src/main/res/xml/${f}.xml`), /<exclude domain="sharedpref" path="note_install_marker.xml" \/>/);
  }
  assert.match(read('../android/app/src/main/java/com/notetrace/app/InstallMarkerPlugin.java'), /FILE = "note_install_marker"/);
  assert.match(read('../android/app/src/main/java/com/notetrace/app/MainActivity.java'), /registerPlugin\(InstallMarkerPlugin\.class\)/);
});
