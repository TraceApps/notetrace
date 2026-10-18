// Requests explicitly choose their response format (nutritrace#258).
// Custom chat providers opt into SSE; extraction and legacy relay callers
// continue to request JSON.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the server relay permits streaming only for custom providers that opt in', () => {
  const ai = read('../server/routes/ai.js');
  const relay = ai.slice(ai.indexOf('export function relayRequest'), ai.indexOf("router.post('/relay'"));
  assert.ok(relay.indexOf('out.stream = custom && body.stream === true;') > relay.indexOf('for (const k of RELAY_FIELDS[kind])'));
  assert.match(relay, /out.stream \? 'text\/event-stream, application\/json' : 'application\/json'/);
});

test("the app's own requests ask for JSON", () => {
  assert.match(read('../src/lib/aiChat.js'), /const headers = \{ 'Content-Type': 'application\/json', 'Accept': 'application\/json' \};/);
  const extract = read('../src/lib/ai-extract.js');
  assert.match(extract, /'Accept': 'application\/json'/);
  assert.match(extract, /body: JSON\.stringify\(\{ model: cfg\.model, stream: false,/);
});
