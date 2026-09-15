import assert from 'node:assert/strict';
import test from 'node:test';
import { firstUrl, firstNoteUrl, parseLinkPreview } from '../server/lib/link-preview-core.js';

test('firstUrl finds the first link and drops trailing punctuation', () => {
  assert.equal(firstUrl('See https://example.com/guide.'), 'https://example.com/guide');
  assert.equal(firstUrl('(http://a.example.org/x?y=1), then more'), 'http://a.example.org/x?y=1');
  assert.equal(firstUrl('no link here'), null);
  assert.equal(firstUrl('**https://example.com/b**'), 'https://example.com/b');
});

test('firstNoteUrl looks at title, text, then checklist items', () => {
  assert.equal(firstNoteUrl({ title: 'x', body_md: 'y', items: [{ text: 'read https://news.example.org/a' }] }), 'https://news.example.org/a');
  assert.equal(firstNoteUrl({ title: 'https://t.example.com', body_md: 'https://b.example.com' }), 'https://t.example.com/');
  assert.equal(firstNoteUrl({ title: 'none' }), null);
});

test('parseLinkPreview reads Open Graph, falls back to title and favicon', () => {
  const html = `<html><head>
    <title>Fallback &amp; Title</title>
    <meta property="og:title" content="The &quot;Real&quot; Title">
    <meta name="description" content="A plain description">
    <meta property="og:image" content="/img/cover.jpg">
    <meta property="og:site_name" content="Example Site">
    <link rel="icon" href="/favicon-32.png">
  </head><body></body></html>`;
  const p = parseLinkPreview(html, 'https://www.example.com/post/1');
  assert.equal(p.title, 'The "Real" Title');
  assert.equal(p.description, 'A plain description');
  assert.equal(p.image, 'https://www.example.com/img/cover.jpg');
  assert.equal(p.site, 'Example Site');
  assert.equal(p.icon, 'https://www.example.com/favicon-32.png');
  const bare = parseLinkPreview('<title> Just a title </title>', 'https://www.example.org/a');
  assert.equal(bare.title, 'Just a title');
  assert.equal(bare.site, 'example.org');
  assert.equal(bare.image, null);
  assert.equal(bare.icon, 'https://www.example.org/favicon.ico');
  assert.equal(parseLinkPreview('<meta property="og:image" content="javascript:alert(1)">', 'https://x.example').image, null);
});
