import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationSoundPlayer, NOTIFICATION_SOUNDS } from '../src/lib/notification-sound-core.js';

function fixture(state = 'suspended') {
  const tones = [], peaks = [];
  const context = {
    state, currentTime: 10, destination: {},
    async resume() { this.state = 'running'; },
    createOscillator() {
      const tone = { frequency: { setValueAtTime: value => { tone.hz = value; } }, connect() {}, disconnect() {}, start(t) { tone.start = t; }, stop(t) { tone.stop = t; } };
      tones.push(tone); return tone;
    },
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime: peak => peaks.push(peak), exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; },
  };
  return { context, tones, peaks, player: createNotificationSoundPlayer(() => context) };
}
test('sound waits for an audio context unlocked by a user action', async () => {
  const f = fixture();
  assert.equal(f.player.play('gentle', 50), false);
  assert.equal(f.tones.length, 0);
  assert.equal(await f.player.unlock(), true);
  assert.equal(f.player.play('gentle', 50), true);
  assert.equal(f.tones.length, 2);
  assert.ok(f.tones.every(t => t.stop > t.start));
});
test('all sound choices schedule finite, bounded tones and clean up on completion', async () => {
  for (const sound of NOTIFICATION_SOUNDS) {
    const f = fixture(); await f.player.unlock();
    assert.equal(f.player.play(sound.id, 500), true);
    assert.equal(f.tones.length, sound.notes.length);
    assert.ok(f.peaks.every(peak => peak > 0 && peak <= 0.16));
    for (const tone of f.tones) { assert.ok(Number.isFinite(tone.hz)); tone.onended(); }
  }
});
test('muting stays silent and a burst of notifications does not stack tones', async () => {
  const f = fixture(); await f.player.unlock();
  assert.equal(f.player.play('bell', 0), false);
  assert.equal(f.player.play('bell', -10), false);
  assert.equal(f.tones.length, 0);
  f.player.play('gentle', 50);
  const count = f.tones.length;
  assert.equal(f.player.play('digital', 50), true);
  assert.equal(f.tones.length, count);
  f.context.currentTime += 1;
  f.player.play('digital', 50);
  assert.ok(f.tones.length > count);
});
test('unavailable audio and stale sound ids do not break notification delivery', async () => {
  const unavailable = createNotificationSoundPlayer(() => { throw new Error('unavailable'); });
  assert.equal(await unavailable.unlock(), false);
  assert.equal(unavailable.play('gentle'), false);
  const f = fixture(); await f.player.unlock();
  assert.equal(f.player.play('removed-font-style-id', 50), true);
  assert.equal(f.tones[0].hz, NOTIFICATION_SOUNDS[0].notes[0][0]);
  f.context.state = 'suspended';
  assert.equal(f.player.play('bell'), false);
});
