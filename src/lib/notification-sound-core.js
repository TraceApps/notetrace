export const NOTIFICATION_SOUNDS = [
  { id: 'gentle', notes: [[660, 0, 0.22], [880, 0.16, 0.3]], wave: 'sine' },
  { id: 'chime', notes: [[523.25, 0, 0.3], [659.25, 0.12, 0.3], [783.99, 0.24, 0.45]], wave: 'sine' },
  { id: 'bell', notes: [[1046.5, 0, 0.55], [1567.98, 0, 0.4]], wave: 'sine' },
  { id: 'pulse', notes: [[440, 0, 0.16], [440, 0.25, 0.16]], wave: 'triangle' },
  { id: 'digital', notes: [[740, 0, 0.12], [987.77, 0.13, 0.16], [1318.51, 0.3, 0.22]], wave: 'triangle' },
];

export function createNotificationSoundPlayer(createContext) {
  let context;
  let lastPlayed = -Infinity;
  async function unlock() {
    try {
      if (!context || context.state === 'closed') context = createContext();
      if (context?.state === 'suspended') await context.resume();
      return context?.state === 'running';
    } catch { return false; }
  }
  function play(id, volume = 50) {
    if (!context || context.state !== 'running') return false;
    const level = Math.max(0, Math.min(100, Number(volume) || 0)) / 100;
    if (!level) return false;
    // A burst of reminders should chime once rather than stack loud tones.
    if (context.currentTime - lastPlayed < 0.25) return true;
    const sound = NOTIFICATION_SOUNDS.find(s => s.id === id) || NOTIFICATION_SOUNDS[0];
    try {
      for (const [frequency, delay, duration] of sound.notes) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + delay;
        oscillator.type = sound.wave;
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(level * 0.16 / sound.notes.length, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(start);
        oscillator.stop(start + duration + 0.03);
      }
      lastPlayed = context.currentTime;
      return true;
    } catch { return false; }
  }
  return { unlock, play };
}
