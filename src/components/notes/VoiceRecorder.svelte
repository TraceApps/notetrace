<script>
  /**
   * VoiceRecorder: records a voice note with a live level meter, pause and
   * resume; emits `done` with the recording, or `cancel`.
   */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { startRecording, formatDuration, recordingSupported } from '../../lib/voice-recorder.js';

  /** Offer to pick an audio file instead of recording. */
  export let canAddFile = false;
  const dispatch = createEventDispatcher();
  const BARS = 32;
  let handle = null;
  let elapsed = 0;
  let paused = false;
  let meter = Array(BARS).fill({ v: 0, p: null });
  // Microphones differ a lot in how hot they run, so the meter keeps the
  // loudest of the last few seconds and scales to that, within limits: a quiet
  // phone still fills the bars, a loud one doesn't sit pinned at the top.
  const QUIET_TOP = 0.55;   // the lowest ceiling the meter will scale to
  let recentTop = QUIET_TOP;
  let shown = 0;
  let timer = null;
  let error = '';
  let stopping = false;
  let gone = false;

  onMount(async () => {
    if (!recordingSupported()) { error = $_('voice.unsupported'); return; }
    try {
      const h = await startRecording();
      // Closed while the permission prompt was up: release the mic.
      if (gone) { h.cancel(); return; }
      handle = h;
      timer = setInterval(tick, 100);
    } catch (e) {
      if (!gone) error = /denied/i.test(String(e?.message || '')) || e?.name === 'NotAllowedError' ? $_('voice.denied') : (e?.message || $_('voice.denied'));
    }
  });
  onDestroy(() => {
    gone = true;
    clearInterval(timer);
    if (handle && !stopping) handle.cancel();
  });

  let sampleAt = 0;
  function tick() {
    if (!handle) return;
    elapsed = handle.elapsed();
    paused = handle.paused;
    // The meter scrolls: a new bar about every 100ms while recording.
    const now = Date.now();
    if (!paused && now - sampleAt > 100) {
      sampleAt = now;
      const raw = handle.level();
      // Jump to a syllable at once, fall away gently, so speech reads as shape
      // rather than as flicker.
      shown = raw > shown ? raw : shown * 0.62 + raw * 0.38;
      recentTop = Math.max(raw, recentTop * 0.992, QUIET_TOP);
      meter = [...meter.slice(1), { v: Math.min(1, shown / recentTop), p: handle.pitch?.() ?? null }];
    }
    // Stopped from the Android notification, or at the time limit.
    if (handle.finished || elapsed >= handle.limitMs) stop();
  }

  function togglePause() {
    if (!handle || stopping) return;
    if (handle.paused) handle.resume(); else handle.pause();
    paused = handle.paused;
  }
  async function stop() {
    if (!handle || stopping) return;
    stopping = true;
    clearInterval(timer);
    const rec = await handle.stop();
    if (rec.blob.size) dispatch('done', rec); else dispatch('cancel');
  }
  function cancel() {
    stopping = true;
    handle?.cancel();
    dispatch('cancel');
  }
</script>

<div class="vr">
  {#if error}
    <p class="vr-error" role="alert">{error}</p>
    <button class="btn btn-secondary" on:click={() => dispatch('cancel')}>{$_('common.close')}</button>
  {:else}
    <div class="vr-status" aria-live="polite">
      <span class="dot" class:live={!!handle && !stopping && !paused} class:paused></span>
      <span>{paused ? $_('voice.paused') : $_('voice.recording')}</span>
      <span class="time">{formatDuration(elapsed)}</span>
    </div>
    <div class="vr-meter" class:paused aria-hidden="true">
      {#each meter as b, i (i)}
        <span style="height:{Math.max(5, Math.round((b?.v || 0) * 100))}%{b?.p == null ? '' : `;--pitch:${b.p.toFixed(2)}`}"></span>
      {/each}
    </div>
    <p class="vr-hint">
      {handle?.native ? $_('voice.limit_native') : $_('voice.limit')}
      {#if canAddFile}<button class="vr-file" on:click={() => { stopping = true; handle?.cancel(); dispatch('file'); }}>{$_('voice.add_file_instead')}</button>{/if}
    </p>
    <div class="vr-buttons">
      <button class="btn btn-secondary vr-discard" on:click={cancel}>{$_('voice.cancel')}</button>
      <button class="btn btn-secondary vr-pause" on:click={togglePause} disabled={!handle || stopping}
        aria-label={paused ? $_('voice.resume') : $_('voice.pause_recording')}>
        <span class="material-symbols-rounded">{paused ? 'fiber_manual_record' : 'pause'}</span>{paused ? $_('voice.resume') : $_('voice.pause_recording')}
      </button>
      <button class="btn btn-primary" on:click={stop} disabled={!handle || stopping}>
        <span class="material-symbols-rounded">stop</span>{$_('voice.stop')}
      </button>
    </div>
  {/if}
</div>

<style>
  .vr { display: flex; flex-direction: column; gap: 12px; padding: 6px; min-width: min(360px, calc(100vw - 48px)); }
  .vr-status { display: flex; align-items: center; gap: 10px; font-size: 15px; color: var(--text-1); }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--text-3); flex-shrink: 0; }
  .dot.live { background: var(--danger, #ff5c5c); animation: pulse 1.2s ease-in-out infinite; }
  .dot.paused { background: var(--warning, #ffb547); }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .time { margin-left: auto; font-variant-numeric: tabular-nums; font-size: 22px; font-weight: 600; }
  .vr-meter { display: flex; align-items: center; gap: 3px; height: 58px; padding: 0 2px; }
  /* Bars grow from the middle, and lean toward the second accent as the voice
     gets brighter, so the meter shows pitch as well as loudness. */
  .vr-meter span {
    flex: 1; min-height: 3px; border-radius: 3px;
    background: color-mix(in srgb, var(--accent-2) calc(var(--pitch, 0) * 100%), var(--accent));
    transition: height 80ms linear;
  }
  .vr-meter.paused span { background: var(--text-3); }
  .vr-hint { font-size: 12px; color: var(--text-3); display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
  .vr-file { font-size: 12px; color: var(--accent); padding: 0; }
  .vr-file:hover { text-decoration: underline; }
  .vr-error { font-size: 14px; color: var(--text-1); line-height: 1.5; }
  .vr-buttons { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .vr-buttons .btn { display: inline-flex; align-items: center; gap: 6px; }
  .vr-buttons .material-symbols-rounded { font-size: 18px; }
  .vr-pause .material-symbols-rounded { color: var(--danger, #ff5c5c); }
  @media (prefers-reduced-motion: reduce) { .dot.live { animation: none; } .vr-meter span { transition: none; } }
</style>
