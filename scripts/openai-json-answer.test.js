// Every OpenAI-compatible request asks for one JSON answer, never a stream:
// some gateways stream when `stream` is missing, and the reply then can't be
// read (TraceApps/nutritrace#258). These paths don't go through
// getOpenAIChatParams, so they are checked here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the server relay forces stream: false after its field allowlist', () => {
  const ai = read('../server/routes/ai.js');
  const relay = ai.slice(ai.indexOf('export function relayRequest'), ai.indexOf("router.post('/relay'"));
  assert.ok(relay.indexOf('out.stream = false;') > relay.indexOf('for (const k of RELAY_FIELDS[kind])'));
  assert.match(relay, /'Accept': 'application\/json'/);
});

test("the app's own requests ask for JSON", () => {
  assert.match(read('../src/lib/aiChat.js'), /const headers = \{ 'Content-Type': 'application\/json', 'Accept': 'application\/json' \};/);
  const extract = read('../src/lib/ai-extract.js');
  assert.match(extract, /'Accept': 'application\/json'/);
  assert.match(extract, /body: JSON\.stringify\(\{ model: cfg\.model, stream: false,/);
});
