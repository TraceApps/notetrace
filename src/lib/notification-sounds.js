import { get } from 'svelte/store';
import { isNative } from './platform.js';
import { notifLocalEnabled, notifSoundEnabled, notifSound, notifSoundVolume } from '../stores/settings.js';
import { createNotificationSoundPlayer } from './notification-sound-core.js';

const player = createNotificationSoundPlayer(() => {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  return Context ? new Context() : null;
});

export function startNotificationSounds() {
  if (isNative) return;
  const unlock = () => { if (get(notifSoundEnabled) === true) player.unlock(); };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  const release = notifSoundEnabled.subscribe(enabled => { if (enabled === true) player.unlock(); });
  return () => {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    release();
  };
}

export async function previewNotificationSound() {
  if (!(await player.unlock())) return false;
  return player.play(get(notifSound), get(notifSoundVolume));
}

// Request silent OS delivery after a custom tone, avoiding duplicate sounds.
// If autoplay is blocked, allow the system's default sound as a fallback.
export function notificationSoundSilent() {
  const volume = Number(get(notifSoundVolume));
  if (get(notifLocalEnabled) === false || get(notifSoundEnabled) !== true || !Number.isFinite(volume) || volume <= 0) return true;
  return player.play(get(notifSound), get(notifSoundVolume));
}
