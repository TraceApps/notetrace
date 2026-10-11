/**
 * A fresh install's welcome screen showed the "Offline. Edits are kept
 * here" pill with the server right there (over http:// and on localhost):
 * the Notes page and the sidebar loaded behind the wizard, and the server
 * refuses every data request with 503 "Setup required" until the first
 * account exists, which the offline layer took for the server being down. Nothing but the wizard may render, or ask the server for
 * data, while the server says setup is required; and that answer never
 * counts as offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const app = read('../src/App.svelte');

test('the web app renders nothing until a fresh install is on the wizard', () => {
  assert.match(app, /\$: _setupFirst = !isNative && \$setupRequired;/);
  assert.match(app, /\$: _setupPending = _setupFirst && \$location !== '\/wizard';/);
  assert.match(app, /\{:else if !authLoaded \|\| _setupPending\}/, 'the blank branch also covers the way to setup');
  assert.ok(app.indexOf('{:else if !authLoaded || _setupPending}') < app.indexOf('<Router {routes} />'));
});

test('going anywhere else before setup is done comes back to the wizard', () => {
  assert.match(app, /\$: if \(_setupRouted && _setupPending\) _recheckSetup\(\);/);
  assert.match(app, /goWizard: \(\) => \{ if \(getStore\(location\) !== '\/wizard'\) replace\('\/wizard'\); \}/);
  // Replaced, never pushed: Back from the wizard must not land on a page that can't load.
  assert.match(app, /if \(!isNative && \$setupRequired\) \{\s*(\/\/[^\n]*\n\s*)*replace\('\/wizard'\);/);
  // A failing OIDC callback can't stop the redirect.
  assert.match(app, /try \{ await handleOidcCallback\(\); \} catch/);
  // Armed only after the first routing decision, so it never runs ahead of the OIDC callback.
  assert.ok(app.indexOf('_setupRouted = true;') > app.indexOf('await handleOidcCallback();'));
  assert.doesNotMatch(app, /\$setupRequired\) \{\s*window\.location\.hash = '#\/wizard'/);
});

test('nothing in the shell asks for data the server refuses before setup', () => {
  assert.match(app, /if \(!\(\$userMgmtActive && !\$currentUser\) && \(isNative \|\| !\$setupRequired\)\) loadEnvLocks\(\);/, 'env locks wait for setup');
  assert.match(app, /\{#if !_setupFirst\}<Trace \/>\{\/if\}/, 'Trace (chat history) waits for setup');
  assert.match(app, /\{#if !_setupFirst\}<Sidebar /, 'the sidebar (labels, reminder counts, CookTrace link) waits for setup');
  assert.doesNotMatch(app, /^<Trace \/>$/m);
  assert.doesNotMatch(app, /^<Sidebar /m);
});

test('once setup is done, what was held back loads', () => {
  // Signed in only: after registering over a dropped cookie it would just be refused (sign-in loads it).
  assert.match(app, /else if \(_wasSetupFirst\) \{ _wasSetupFirst = false; if \(!\(\$userMgmtActive && !\$currentUser\)\) loadEnvLocks\(\); \}/);
});

test('the API layer marks the server\'s Setup required answer', () => {
  assert.match(read('../src/lib/api.js'), /if \(e\.setup_required\) err\.setupRequired = true;/);
  assert.match(read('../server/index.js'), /res\.status\(503\)\.json\(\{ error: 'Setup required', setup_required: true \}\)/);
});

test('edits left from before wait quietly while the server is not set up', () => {
  const off = read('../src/lib/offline-api.js');
  const quiet = off.match(/if \(err\.setupRequired\) \{ _publish\(\{ syncing: false, error: null, online: true \}\); _scheduleFlush\(_backoff\(\)\); return false; \}/g) || [];
  assert.equal(quiet.length, 2, 'both the plain requests and the note push');
});

test('reads and edits fall back and queue on Setup required, without the Offline pill', () => {
  const off = read('../src/lib/offline-api.js');
  assert.doesNotMatch(off, /if \(!isOfflineError\(err\)\) throw err;/, 'every fallback site asks isUnavailableError');
  const sites = off.match(/if \(!isUnavailableError\(err\)\) throw err;\n\s*if \(isOfflineError\(err\)\) (offlineState\.update|_publish)\(/g) || [];
  assert.equal(sites.length, 6, 'read, write, uploadImage, uploadFile, updateProfile, addAttachments');
  assert.match(off, /if \(isUnavailableError\(err\)\) throw _offlineError\(\);/, 'server-only actions say they need a connection, as before');
});
