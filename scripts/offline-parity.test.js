/**
 * NoteTrace carries the same offline shape as the other Trace apps: what
 * each of them learned the hard way is wired here too. Text checks, so they
 * run without a browser; behaviour is covered by design/tools/offline-*.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const offline = read('../src/lib/offline-api.js');
const api = read('../src/lib/api.js');
const auth = read('../src/stores/auth.js');
const settings = read('../src/stores/settings.js');

test('the queue keeps its owner, and what a page kept before sign-in follows it', () => {
  // The app clears `wl:userId` when it cannot confirm who is signed in, and
  // the first reads of a page happen before it knows. Either one used to
  // strand the queue in a database nothing reads. LiftTrace lost work that way.
  assert.match(offline, /const _USER_KEY = 'note:offline-user'/);
  assert.match(offline, /else user = localStorage\.getItem\(_USER_KEY\)/);
  assert.match(offline, /async function _absorb\(/);
  assert.match(offline, /indexedDB\.deleteDatabase\(oldName\)/);
});

test('signing out sends what is waiting, and asks before discarding it', () => {
  // The guard lives in logout(), so every way of signing out is covered,
  // not just the button that happened to have it.
  const i = auth.indexOf('flushOutbox');
  assert.ok(i > 0, 'sign-out flushes the outbox');
  assert.ok(auth.indexOf('clearOfflineData') > i, 'and only then clears the copy');
  assert.match(auth, /if \(!ok\) return false;/);
});

test('a setting changed with no connection is kept, not just applied locally', () => {
  assert.match(settings, /queueRequest\(\{ kind: `the "\$\{key\}" setting`/);
});

test('your profile and its picture work the same way as in the sibling apps', () => {
  assert.match(api, /updateProfile\(data\)\s+\{ return this\.put\('\/api\/auth\/profile', data\); \}/);
  assert.match(offline, /async updateProfile\(data\)/);
  assert.match(offline, /embeddableDataUrl\(file\)/);
  const profile = read('../src/routes/Profile.svelte');
  assert.match(profile, /await NoteApi\.updateProfile\(/);
  assert.ok(!/fetch\(apiUrl\('\/api\/auth\/profile'\)/.test(profile), 'no raw fetch around the API layer');
  // And local mode is decided reactively, so opening the screen before the
  // auth check answers cannot write a profile to local settings instead.
  assert.match(profile, /\$: _isLocal = /);
});

test('a picture on a note survives with no connection, and becomes a file on arrival', () => {
  // A note with pictures used to go straight to the server, so it simply
  // failed offline.
  assert.ok(!/if \(Array\.isArray\(data\.attachments\) && data\.attachments\.length\) return http\.createNote/.test(offline));
  assert.match(offline, /kind: 'a picture you added'/);
  // Every attachment url passes through one place on the server, so the
  // REST routes and the sync push both get this.
  const notes = read('../server/lib/notes.js');
  assert.match(notes, /if \(s\.startsWith\('data:image\/'\)\)/);
  assert.match(notes, /localizeDataUrl/);
  // A file that is not an image is refused, whatever its type says.
  const localizer = read('../server/lib/image-localizer.js');
  assert.match(localizer, /detectImageTypeFromBuffer/);
});

test('a refusal from the server is said in words, not just a red badge', () => {
  assert.match(offline, /console\.error\(`\[offline\] your server refused/);
});
