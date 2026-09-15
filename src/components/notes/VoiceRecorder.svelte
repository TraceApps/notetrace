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
  let meter = Array(BARS).fill(0);
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
    } catch {
      if (!gone) error = $_('voice.denied');
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
    // The meter scrolls: a new bar about every 120ms while recording.
    const now = Date.now();
    if (!paused && now - sampleAt > 120) {
      sampleAt = now;
      meter = [...meter.slice(1), handle.level()];
    }
    if (elapsed >= handle.limitMs) stop();
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
      {#each meter as v, i (i)}<span style="height:{Math.max(6, Math.round(v * 100))}%"></span>{/each}
    </div>
    <p class="vr-hint">
      {$_('voice.limit')}
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
  .vr-meter { display: flex; align-items: center; gap: 3px; height: 48px; padding: 0 2px; }
  .vr-meter span { flex: 1; min-height: 3px; border-radius: 3px; background: var(--accent); transition: height 90ms linear; }
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
