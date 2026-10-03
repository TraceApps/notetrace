/**
 * The <head> tags a public note link sends to chat apps and social sites.
 * Everything here comes from the note, so it all has to be escaped.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, publicNoteDescription, publicNoteHead, injectPublicNoteHead, publicPageHtml } from '../server/lib/public-note-meta.js';

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
