/**
 * Static-analysis tests for outgoing webhooks wiring.
 *
 * These do not exercise real deliveries; they guard against accidental
 * unwiring of the route mount, the feature flags, or an event call site
 * being removed during future refactors. Pure text/regex checks over
 * the source files, no db.js import, so this runs without a compiled
 * better-sqlite3 native binding. Real delivery verification (signature,
 * retry, SSRF guard against a live target) requires a running dev
 * server with WEBHOOKS_ENABLED=1 and a test receiver.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexJs      = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const routeJs      = readFileSync(new URL('../server/routes/webhooks.js', import.meta.url), 'utf8');
const libJs        = readFileSync(new URL('../server/lib/webhooks.js', import.meta.url), 'utf8');
const deliveryJs   = readFileSync(new URL('../server/lib/webhook-delivery.js', import.meta.url), 'utf8');
const dbJs         = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');

test('webhooks route is mounted at /api/admin/webhooks on the main router', () => {
  assert.match(indexJs, /import webhooksRoutes[\s\S]*from '\.\/routes\/webhooks\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/admin\/webhooks',\s*webhooksRoutes\)/);
});

test('webhooks CRUD route requires session auth (requireAuth, requireAdmin), not bearer', () => {
  assert.match(routeJs, /requireAuth,\s*requireAdmin/);
  assert.doesNotMatch(routeJs, /bearerAuth/);
});

test('webhooks table exists with an encrypted secret column, not a hash', () => {
  assert.match(dbJs, /CREATE TABLE IF NOT EXISTS webhooks/);
  assert.match(dbJs, /secret_encrypted/);
});

test('webhook delivery is gated on WEBHOOKS_ENABLED, off by default', () => {
  assert.match(libJs, /WEBHOOKS_ENABLED/);
});

test('webhook target URLs are validated through the shared SSRF guard, at creation and before delivery', () => {
  assert.match(libJs, /import \{ assertSafeUrl \} from '\.\/ssrf-guard\.js'/);
  const occurrences = [...libJs.matchAll(/assertSafeUrl\(/g)];
  assert.ok(occurrences.length >= 3, 'expected assertSafeUrl called at create, update, and delivery time');
});

test('assertSafeUrl is re-checked inside the retry loop, not just once before it (regression check)', () => {
  // A prior version called assertSafeUrl once before the `for` loop
  // started, so only the FIRST attempt was actually re-validated;
  // retries 2 and 3 (up to ~2.5s later) reused the already-decided
  // envelope/signature without checking DNS again. The call must be
  // textually inside the loop body, immediately before sendWebhookRequest.
  const loopMatch = libJs.match(/for \(let attempt = 0;[\s\S]*?\n {2}\}\n\}/);
  assert.ok(loopMatch, 'expected to find the retry for-loop in webhooks.js');
  assert.match(loopMatch[0], /assertSafeUrl\(/, 'assertSafeUrl should be called inside the retry loop body');
  const assertIdx = loopMatch[0].indexOf('assertSafeUrl(');
  const sendIdx = loopMatch[0].indexOf('sendWebhookRequest(');
  assert.ok(assertIdx >= 0 && sendIdx >= 0 && assertIdx < sendIdx, 'assertSafeUrl should run immediately before sendWebhookRequest on each attempt');
});

test('the three known events are all registered with descriptions', () => {
  for (const event of ['note.created', 'checklist.completed', 'reminder.fired']) {
    assert.match(libJs, new RegExp(`'${event.replace('.', '\\.')}'`));
  }
});

test('delivery is signed with HMAC-SHA256 and carries event/delivery-id headers', () => {
  assert.match(deliveryJs, /createHmac\('sha256'/);
  assert.match(deliveryJs, /X-NoteTrace-Signature/);
  assert.match(deliveryJs, /X-NoteTrace-Event/);
  assert.match(deliveryJs, /X-NoteTrace-Delivery/);
  assert.match(libJs, /import \{ signEnvelope, sendWebhookRequest \} from '\.\/webhook-delivery\.js'/);
});

test('delivery retries up to 3 attempts and never throws out of dispatchWebhookEvent', () => {
  assert.match(libJs, /MAX_ATTEMPTS\s*=\s*3/);
  assert.match(libJs, /export function dispatchWebhookEvent/);
});

test('a test-delivery endpoint exists so a webhook can be verified without waiting for a real event', () => {
  assert.match(routeJs, /router\.post\('\/:id\/test'/);
  assert.match(libJs, /export async function sendTestWebhook/);
});
