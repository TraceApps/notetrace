import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appNavigationMatch, cacheNavigationResponse } from '../src/lib/pwa-routing.js';
import { versionedFonts } from './versioned-fonts.js';

test('online page refresh uses NetworkFirst with the precached shell reserved for offline fallback', () => {
  const config = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.ok(!/navigateFallback:\s*['"]index.html['"]/.test(config));
  assert.match(config, /navigateFallback: null/, 'override the Vite PWA default as well as the Workbox option');
  assert.match(config, /directoryIndex: null/);
  assert.match(config, /urlPattern: appNavigationMatch,[\s\S]*?handler: 'NetworkFirst'/);
  assert.match(config, /precacheFallback: \{ fallbackURL: 'index.html' \}/);
  assert.match(config, /useCredentials: true/);
  assert.match(config, /skipWaiting: false/);
  for (const path of ['/', '/notetrace/', '/notetrace/?fresh=1']) assert.equal(appNavigationMatch({ request: { mode: 'navigate' }, url: new URL(path, 'https://notes.example') }), true);
  for (const path of ['/api/notes', '/notetrace/api/notes', '/uploads/photo.png', '/notetrace/n/abc?x=1', '/share-target']) assert.equal(appNavigationMatch({ request: { mode: 'navigate' }, url: new URL(path, 'https://notes.example') }), false);
});

test('authentication redirects and error pages are never stored as app documents', async () => {
  const request = { url: 'https://notes.example/' };
  const response = { status: 200, url: request.url, headers: new Headers({ 'content-type': 'text/html' }) };
  assert.equal(await cacheNavigationResponse({ request, response }), response);
  for (const change of [{ redirected: true }, { status: 503 }, { type: 'opaqueredirect' }, { url: 'https://login.example/' }, { headers: new Headers({ 'content-type': 'application/json' }) }]) {
    assert.equal(await cacheNavigationResponse({ request, response: { ...response, ...change } }), null);
  }
});

test('the page and offline cache reference a content-versioned font stylesheet', () => {
  let emitted;
  const plugin = versionedFonts();
  plugin.buildStart.call({ emitFile: asset => { emitted = asset; } });
  assert.match(emitted.fileName, /^fonts\/fonts-[a-f0-9]{16}\.css$/);
  assert.ok(emitted.source.includes("font-family: 'Inter'"));
  const html = plugin.transformIndexHtml.handler('<link rel="stylesheet" href="/fonts/fonts.css" />');
  assert.ok(html.includes(`href="./${emitted.fileName}"`));
  assert.ok(!html.includes('href="/fonts/fonts.css"'));
});
