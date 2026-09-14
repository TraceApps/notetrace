/**
 * Server-side transcription and image text (server/lib/ai-extract.js)
 * against a local stand-in for an OpenAI-compatible provider.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { transcribeAudio, readImageText, cleanExtracted, canTranscribe } from '../server/lib/ai-extract.js';

async function fakeProvider(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'] || '', body });
      const out = handler(req.url, body);
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

test('transcription posts the audio as multipart with the model and key', async () => {
  const p = await fakeProvider((url) => url.endsWith('/v1/audio/transcriptions') ? { json: { text: ' Buy stamps. ' } } : { status: 404, json: {} });
  const text = await transcribeAudio({ provider: 'oai-compat', baseUrl: p.base, apiKey: 'k1' }, { buffer: Buffer.from('fake audio'), mime: 'audio/webm' });
  p.close();
  assert.equal(text, 'Buy stamps.');
  assert.equal(p.seen[0].auth, 'Bearer k1');
  assert.match(p.seen[0].type, /multipart\/form-data/);
  assert.match(p.seen[0].body.toString(), /whisper-1/);
});

test('image text sends a vision message and treats NONE as no text', async () => {
  let reply = 'Total: $12';
  const p = await fakeProvider(() => ({ json: { choices: [{ message: { content: reply } }] } }));
  const cfg = { provider: 'oai-compat', baseUrl: p.base, model: 'vision' };
  assert.equal(await readImageText(cfg, { base64: 'AAAA', mime: 'image/png' }), 'Total: $12');
  const sent = JSON.parse(p.seen[0].body.toString());
  assert.equal(sent.messages[0].content[0].image_url.url, 'data:image/png;base64,AAAA');
  reply = 'NONE';
  assert.equal(await readImageText(cfg, { base64: 'AAAA', mime: 'image/png' }), '');
  p.close();
});

test('provider support and errors', async () => {
  assert.equal(canTranscribe('claude'), false);
  await assert.rejects(transcribeAudio({ provider: 'claude' }, { buffer: Buffer.from('x'), mime: 'audio/webm' }), /can't transcribe/);
  const p = await fakeProvider(() => ({ status: 401, json: { error: { message: 'bad key' } } }));
  await assert.rejects(readImageText({ provider: 'oai-compat', baseUrl: p.base, model: 'm' }, { base64: 'A', mime: 'image/png' }), /bad key/);
  p.close();
  assert.equal(cleanExtracted('```\nhello\n```'), 'hello');
});
