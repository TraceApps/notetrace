/**
 * The pure parts of the CookTrace link (server/lib/cooktrace-core.js).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCooktraceUrl, shoppingNames, parseMcpReply, MAX_SEND_ITEMS } from '../server/lib/cooktrace-core.js';

test('normalizeCooktraceUrl trims, drops trailing slashes, and needs http(s)', () => {
  assert.equal(normalizeCooktraceUrl('  https://cook.example.com/// '), 'https://cook.example.com');
  assert.equal(normalizeCooktraceUrl('http://192.168.1.5:3003'), 'http://192.168.1.5:3003');
  assert.equal(normalizeCooktraceUrl('cook.example.com'), '');
  assert.equal(normalizeCooktraceUrl('ftp://cook.example.com'), '');
  assert.equal(normalizeCooktraceUrl(''), '');
});

test('shoppingNames sends unchecked items once, cleaned', () => {
  const items = [
    { text: ' Eggs ', checked: false },
    { text: 'Milk', checked: true },
    { text: 'eggs', checked: false },
    { text: '**Flour**  (2 kg)', checked: false },
    { text: '[[Pancakes]] syrup', checked: false },
    { text: '   ', checked: false },
  ];
  assert.deepEqual(shoppingNames(items), ['Eggs', 'Flour (2 kg)', 'Pancakes syrup']);
  assert.deepEqual(shoppingNames(items, { includeChecked: true }), ['Eggs', 'Milk', 'Flour (2 kg)', 'Pancakes syrup']);
});

test('shoppingNames stops at the send limit', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ text: `Item ${i}`, checked: false }));
  assert.equal(shoppingNames(many).length, MAX_SEND_ITEMS);
});

test('parseMcpReply reads plain JSON and SSE replies', () => {
  const msg = { jsonrpc: '2.0', id: 1, result: { tools: [] } };
  assert.deepEqual(parseMcpReply(JSON.stringify(msg)), msg);
  assert.deepEqual(parseMcpReply(`event: message\ndata: ${JSON.stringify(msg)}\n\n`), msg);
  assert.equal(parseMcpReply('<html>not found</html>'), null);
});
