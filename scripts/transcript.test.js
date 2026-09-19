import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimedText, fromVerboseJson, mergePieces, segmentAt, chunkSeconds, transcribeLimitBytes, whisperStyle } from '../server/lib/transcript.js';
import { parseWaveform, parseSegments, barsFromLevels, meterLevel, worthSummarizing, longEnoughToSummarize, SUMMARY_MIN_CHARS, SUMMARY_MIN_MS, WAVEFORM_BARS } from '../server/lib/voice-meta.js';

test('Gemini-style timed lines', () => {
  const r = parseTimedText('[0:00] Call the plumber.\n[0:04] He comes Friday,\nbefore noon.\n[1:02:03] Done.');
  assert.deepEqual(r.segments.map(s => s.start), [0, 4, 3723]);
  assert.equal(r.segments[1].text, 'He comes Friday, before noon.');
  assert.equal(r.segments[0].end, 4);
  assert.equal(r.text, 'Call the plumber. He comes Friday, before noon. Done.');
  assert.deepEqual(parseTimedText('Just words, no times.'), { text: 'Just words, no times.', segments: null });
});

test('Whisper verbose_json', () => {
  const r = fromVerboseJson({ text: ' Hi there. Bye. ', segments: [{ start: 0, end: 1.5, text: ' Hi there.' }, { start: 1.5, end: 2.2, text: 'Bye.' }] });
  assert.equal(r.text, 'Hi there. Bye.');
  assert.deepEqual(r.segments[1], { start: 1.5, end: 2.2, text: 'Bye.' });
  assert.equal(fromVerboseJson({ text: 'x' }).segments, null);
});

test('pieces of a long recording join with their offsets', () => {
  const r = mergePieces([
    { offset: 0, text: 'One.', segments: [{ start: 0, end: 2, text: 'One.' }] },
    { offset: 600, text: 'Two.', segments: [{ start: 1, end: 3, text: 'Two.' }] },
  ]);
  assert.equal(r.text, 'One. Two.');
  assert.deepEqual(r.segments[1], { start: 601, end: 603, text: 'Two.' });
  assert.equal(mergePieces([{ offset: 0, text: 'a', segments: [{ start: 0, end: 1, text: 'a' }] }, { offset: 60, text: 'b', segments: null }]).segments, null);
});

test('finding the playing segment and sizing pieces', () => {
  const segs = [{ start: 0 }, { start: 5 }, { start: 9 }];
  assert.equal(segmentAt(segs, 0), 0);
  assert.equal(segmentAt(segs, 7), 1);
  assert.equal(segmentAt(segs, 99), 2);
  assert.equal(segmentAt(null, 3), -1);
  // An hour at 32 kbps (14.4 MB) against Gemini's limit splits into pieces under it.
  const secs = chunkSeconds(14.4e6, 3600, transcribeLimitBytes('gemini'));
  assert.ok(secs < 3600 && (14.4e6 / 3600) * secs < transcribeLimitBytes('gemini'));
  assert.equal(whisperStyle('whisper-1'), true);
  assert.equal(whisperStyle('gpt-4o-mini-transcribe'), false);
});

test('voice note waveform and segments are cleaned', () => {
  assert.equal(parseWaveform('[0,0,0]'), null);
  assert.deepEqual(parseWaveform([150, -4, 50.4]), [100, 0, 50]);
  assert.equal(parseWaveform('nope'), null);
  assert.deepEqual(parseSegments('[{"start":1.234,"end":2,"text":" hi "},{"start":"x","text":"bad"}]'), [{ start: 1.2, end: 2, text: 'hi' }]);
  const bars = barsFromLevels(Array.from({ length: 500 }, (_, i) => (i % 50) / 50));
  assert.equal(bars.length, WAVEFORM_BARS);
  assert.ok(Math.max(...bars) === 100 && Math.min(...bars) >= 4);
  assert.equal(barsFromLevels([0, 0]), null);
});

test('summaries are only offered when there is something to compress', () => {
  assert.equal(worthSummarizing(''), false);
  assert.equal(worthSummarizing('Call the plumber.'), false);
  assert.equal(worthSummarizing('x'.repeat(SUMMARY_MIN_CHARS)), true);
  // Before there's a transcript, length stands in for it: a 10 second memo
  // isn't worth a summary, a 5 minute one is, and 10 minutes is only the
  // threshold for summarising without being asked.
  assert.equal(longEnoughToSummarize(10 * 1000), false);
  assert.equal(longEnoughToSummarize(SUMMARY_MIN_MS), true);
  assert.equal(longEnoughToSummarize(5 * 60 * 1000), true);
});

test('levels are measured by ear, not by amplitude', () => {
  assert.equal(meterLevel(0), 0);
  assert.equal(meterLevel(-1), 0);
  assert.equal(meterLevel(1), 1);
  // Speech at a tenth of full scale (-20 dB) should fill most of the meter,
  // which is the whole point: amplitude alone would show a tenth of it.
  const speech = meterLevel(0.1);
  assert.ok(speech > 0.6 && speech < 0.8, `speech level ${speech}`);
  // A quiet room stays near the floor.
  assert.ok(meterLevel(0.001) < 0.05);
  assert.ok(meterLevel(0.02) > meterLevel(0.01));
  // Waveform bars keep the same ordering and lift the quiet parts off the floor.
  const bars = barsFromLevels([1, 0.1, 0.01, 0.001], 4);
  assert.equal(bars[0], 100);
  assert.ok(bars[1] > 30 && bars[1] < 60, `quiet bar ${bars[1]}`);
  assert.ok(bars[0] > bars[1] && bars[1] > bars[2] && bars[2] >= bars[3]);
});
