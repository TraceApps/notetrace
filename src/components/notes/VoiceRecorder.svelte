<script>
  /** VoiceRecorder: records a voice note; emits `done` with the recording, or `cancel`. */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { startRecording, formatDuration, recordingSupported } from '../../lib/voice-recorder.js';

  const dispatch = createEventDispatcher();
  let handle = null;
  let elapsed = 0;
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
      timer = setInterval(() => { elapsed = Date.now() - handle.startedAt; }, 250);
    } catch {
      if (!gone) error = $_('voice.denied');
    }
  });

  onDestroy(() => {
    gone = true;
    clearInterval(timer);
    if (handle && !stopping) handle.cancel();
  });

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
      <span class="dot" class:live={!!handle && !stopping}></span>
      <span>{$_('voice.recording')}</span>
      <span class="time">{formatDuration(elapsed)}</span>
    </div>
    <p class="vr-hint">{$_('voice.limit')}</p>
    <div class="vr-buttons">
      <button class="btn btn-secondary" on:click={cancel}>{$_('voice.cancel')}</button>
      <button class="btn btn-primary" on:click={stop} disabled={!handle || stopping}>
        <span class="material-symbols-rounded">stop_circle</span>{$_('voice.stop')}
      </button>
    </div>
  {/if}
</div>

<style>
  .vr { display: flex; flex-direction: column; gap: 10px; width: 300px; max-width: 100%; }
  :global(.pop-panel.sheet) .vr { width: 100%; }
  .vr-status { display: flex; align-items: center; gap: 10px; font-size: 16px; color: var(--text-1); padding: 6px 0; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--text-3); }
  .dot.live { background: #ef4444; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .time { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }
  .vr-hint { font-size: 12px; color: var(--text-3); }
  .vr-error { font-size: 13px; color: var(--danger); }
  .vr-buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .vr-buttons .btn { height: 40px; display: inline-flex; align-items: center; gap: 6px; }
</style>
