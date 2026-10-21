/**
 * The <head> tags a public note link sends to chat apps and social sites.
 * Everything here comes from the note, so it all has to be escaped.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { appNavigationMatch } from '../src/lib/pwa-routing.js';
import { escapeHtml, publicNoteDescription, publicNoteHead, injectPublicNoteHead, publicPageHtml, STALE_PAGE_RECOVERY_JS } from '../server/lib/public-note-meta.js';

const ctx = { origin: 'https://notes.example.com', basePath: '/nt', pageUrl: 'https://notes.example.com/nt/n/abc' };

test('escapes everything that could close an attribute or open a tag', () => {
  assert.equal(escapeHtml(`"><script>&'`), '&quot;&gt;&lt;script&gt;&amp;&#39;');
});

test('a hostile title cannot break out of the tags', () => {
  const head = publicNoteHead({ title: '"><script>alert(1)</script>', kind: 'text', body_md: '<img src=x onerror=alert(1)>' }, ctx);
  assert.ok(!head.includes('<script>'));
  assert.ok(!head.includes('<img'));
  assert.match(head, /<title>&quot;&gt;&lt;script&gt;/);
});

test('the description is plain text from the body, cut short', () => {
  const d = publicNoteDescription({ kind: 'text', body_md: '# Trip\n\n**Bring** the [map](https://x.y) and [[Packing]]\n\n' + 'word '.repeat(80) });
  assert.ok(d.startsWith('Trip Bring the map and Packing'));
  assert.ok(d.length <= 201 && d.endsWith('…'));
});

test('a checklist describes its items with their ticks', () => {
  const d = publicNoteDescription({ kind: 'checklist', items: [{ text: 'Limes', checked: true }, { text: 'Rice', checked: false }] });
  assert.equal(d, '☑ Limes ☐ Rice');
});

test('the first picture is the preview image, under the base path', () => {
  const head = publicNoteHead({ title: 'Garden', kind: 'text', body_md: '', attachments: [
    { url: '/uploads/a.pdf', mime: 'application/pdf' },
    { url: '/uploads/b.jpg', mime: 'image/jpeg' },
  ] }, ctx);
  assert.match(head, /og:image" content="https:\/\/notes\.example\.com\/nt\/uploads\/b\.jpg"/);
  assert.match(head, /twitter:card" content="summary_large_image"/);
});

test('without a picture the app icon stands in', () => {
  const head = publicNoteHead({ title: '', kind: 'text', body_md: '' }, ctx);
  assert.match(head, /og:image" content="https:\/\/notes\.example\.com\/nt\/icons\/icon-512\.png"/);
  assert.match(head, /twitter:card" content="summary"/);
  assert.match(head, /<title>Untitled note<\/title>/);
  assert.ok(!head.includes('og:description'), 'no empty description');
});

test('the page keeps the token out of referrers and search engines', () => {
  const head = publicNoteHead({ title: 'x', kind: 'text', body_md: 'y' }, ctx);
  assert.match(head, /name="referrer" content="no-referrer"/);
  assert.match(head, /name="robots" content="noindex, nofollow"/);
});

test('injecting replaces the app title instead of adding a second one', () => {
  const html = '<html><head><title>NoteTrace</title><script>window.__NOTE_CONFIG__={}</script></head><body></body></html>';
  const out = injectPublicNoteHead(html, publicNoteHead({ title: 'Garden', kind: 'text', body_md: '' }, ctx));
  assert.equal((out.match(/<title>/g) || []).length, 1);
  assert.match(out, /<title>Garden<\/title>/);
  assert.ok(out.indexOf('__NOTE_CONFIG__') < out.indexOf('og:title'));
});

test('the page loads the app from its root, not from under /n/', () => {
  const html = '<html><head><meta charset="UTF-8" /><script src="./assets/index.js"></script></head></html>';
  assert.ok(publicPageHtml(html, '').indexOf('<base href="/" />') < publicPageHtml(html, '').indexOf('./assets/'));
  assert.match(publicPageHtml(html, '/nt'), /<base href="\/nt\/" \/>/);
});

// TraceApps/notetrace#22. Workbox tests a navigation's path and query together
// (workbox-routing NavigationRoute: url.pathname + url.search), so a link with
// anything after the token has to be left to the server too.
test("the service worker leaves every public link to the server, query and all", () => {
  const toServer = p => !appNavigationMatch({ request: { mode: 'navigate' }, url: new URL(p, 'https://notes.example.com') });
  const tok = 'hYLnYCRymoXCxCGASWYYsA';
  // Any single segment, as the server's /n/:token: a mistyped or cut-off link
  // has to reach the server too, or the recovery would run for it every time.
  for (const p of [`/n/${tok}`, `/n/${tok}/`, `/n/${tok}?fbclid=IwAR0abc`, `/n/${tok}?utm_source=chat&utm_medium=x`, `/notes/n/${tok}?x=1`, '/n/short', '/n/abc.d%20e']) {
    assert.ok(toServer(p), p);
  }
  for (const p of ['/', '/?note=4', `/n/${tok}/edit`, '/notes']) assert.ok(!toServer(p), p);
});

function runRecovery({ sw = true, controlled = true, href = 'https://notes.example.com/n/abc?fbclid=1', store = new Map(), state = null, storageOff = false } = {}) {
  const calls = { unregister: 0, reload: 0 };
  const app = { textContent: '' };
  const scriptURL = 'https://notes.example.com/sw.js';
  const reg = { active: { scriptURL }, unregister: async () => { calls.unregister++; return true; } };
  const hist = { state, replaceState(s) { this.state = s; } };
  const storage = storageOff
    ? { getItem() { throw new Error('off'); }, setItem() { throw new Error('off'); }, removeItem() { throw new Error('off'); } }
    : { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  const ctx = {
    location: { href, reload: () => { calls.reload++; } },
    history: hist,
    sessionStorage: storage,
    navigator: sw ? { serviceWorker: { controller: controlled ? { scriptURL } : null, getRegistration: async () => reg } } : {},
    document: { getElementById: id => (id === 'app' ? app : null) },
  };
  vm.runInNewContext(STALE_PAGE_RECOVERY_JS, ctx);
  return new Promise(r => setTimeout(() => r({ calls, app, store, state: hist.state }), 20));
}

test('a stale cached page stops its worker and loads the link from the server, once', async () => {
  const first = await runRecovery();
  assert.deepEqual(first.calls, { unregister: 1, reload: 1 });
  assert.equal(first.app.textContent, 'Opening...');
  // Still the cached page after that reload: say so instead of reloading forever.
  const second = await runRecovery({ store: first.store, state: first.state });
  assert.deepEqual(second.calls, { unregister: 0, reload: 0 });
  assert.match(second.app.textContent, /could not be opened/);
  assert.equal(second.store.size, 0);
  // The guard holds with storage turned off too.
  const off1 = await runRecovery({ storageOff: true });
  assert.deepEqual(off1.calls, { unregister: 1, reload: 1 });
  const off2 = await runRecovery({ storageOff: true, state: off1.state });
  assert.deepEqual(off2.calls, { unregister: 0, reload: 0 });
  // No worker in charge: the page didn't come from one, so reloading can't help.
  for (const opts of [{ sw: false }, { controlled: false }]) {
    const r = await runRecovery(opts);
    assert.deepEqual(r.calls, { unregister: 0, reload: 0 });
    assert.match(r.app.textContent, /could not be opened/);
  }
});

// TraceApps/notetrace#22. Behind a reverse proxy that asks for a login, a
// fetch with credentials 'omit' goes out without the browser's proxy login
// and the proxy refuses it; the page then said it couldn't load the note.
test('the public page asks for the note with the browser\'s own login, not without it', () => {
  const page = readFileSync(new URL('../src/routes/PublicNote.svelte', import.meta.url), 'utf8');
  assert.match(page, /fetch\(apiUrl\(`\/api\/n\/[\s\S]{0,80}?credentials: 'same-origin'/);
  assert.doesNotMatch(page, /credentials: 'omit'/);
});
