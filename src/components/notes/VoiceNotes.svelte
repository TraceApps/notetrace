<script>
  /**
   * VoiceNotes: a note's voice recordings. Each has a waveform to scrub, play
   * speed, and picks up where you stopped listening; below it, the transcript
   * (or a Transcribe button when Trace can do it).
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { formatDuration, waveformFromBlob } from '../../lib/voice-recorder.js';
  import { fetchAttachmentBlob } from '../../lib/ai-extract.js';
  import { voicePlaybackRate } from '../../stores/settings.js';
  import { WAVEFORM_BARS, worthSummarizing, longEnoughToSummarize } from '../../../server/lib/voice-meta.js';
  import { segmentAt } from '../../../server/lib/transcript.js';


  export let notes = [];          // audio attachments
  export let editable = false;
  export let canTranscribe = false;
  export let busy = {};           // uuid -> 'transcribing' | 'summarizing' | true while Trace works
  export let canSummarize = false;

  const dispatch = createEventDispatcher();
  const RATES = [1, 1.25, 1.5, 2];
  // With a summary on a recording, the transcript folds away behind it: the
  // summary is what you came to read, the transcript is the evidence.
  let showTranscript = {};        // uuid -> true
  const toggleTranscript = (id) => showTranscript = { ...showTranscript, [id]: !showTranscript[id] };
  const summaryLines = (text) => String(text || '').split('\n').map(l => l.replace(/^\s*[-*\u2022]\s*/, '').trim()).filter(Boolean);
  const busyLabel = (state) => state === 'summarizing' ? 'trace_extract.summarizing' : 'trace_extract.transcribing';
  const POS_KEY = 'note:voicepos';

  let playing = null;             // uuid
  let audio = null;
  let audioUuid = null;
  let position = {};              // uuid -> seconds
  let durations = {};             // uuid -> seconds, when the file reports one
  let waves = {};                 // uuid -> bars measured on this device

  // ── Where each recording was left ─────────────────────────────────
  function _loadPositions() {
    try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}') || {}; } catch { return {}; }
  }
  function _savePosition(uuid, secs, total) {
    try {
      const all = _loadPositions();
      // Barely started, or at the very end: start from the top next time.
      if (!secs || secs < 1 || (total && secs > total - 0.5)) delete all[uuid];
      else all[uuid] = Math.round(secs);
      const keys = Object.keys(all);
      if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete all[k];
      localStorage.setItem(POS_KEY, JSON.stringify(all));
    } catch { /* private mode */ }
  }
  position = Object.fromEntries(Object.entries(_loadPositions()));

  // Templates pass the state they read, so they update when it changes.
  const total = (a, d = durations) => d[a.uuid] || (a.duration_ms ? a.duration_ms / 1000 : 0);

  // ── Playback ──────────────────────────────────────────────────────
  function _ensureAudio(a) {
    if (audio && audioUuid === a.uuid) return audio;
    if (audio) { _savePosition(audioUuid, audio.currentTime, durations[audioUuid]); audio.pause(); }
    audioUuid = a.uuid;
    audio = new Audio(resolveAssetUrl(a.url));
    audio.preload = 'metadata';
    const el = audio;
    el.playbackRate = $voicePlaybackRate || 1;
    el.onloadedmetadata = () => {
      // Browser recordings (WebM) don't carry a length; seeking far ahead makes the browser work it out.
      if (!Number.isFinite(el.duration)) {
        const want = el.currentTime;
        el.ondurationchange = () => {
          if (!Number.isFinite(el.duration)) return;
          el.ondurationchange = null;
          durations = { ...durations, [a.uuid]: el.duration };
          el.currentTime = want;
        };
        el.currentTime = 1e7;
      } else {
        durations = { ...durations, [a.uuid]: el.duration };
      }
    };
    el.ontimeupdate = () => {
      if (el.currentTime < 1e6) position = { ...position, [a.uuid]: el.currentTime };
    };
    el.onpause = () => _savePosition(a.uuid, el.currentTime, durations[a.uuid] || total(a));
    el.onended = () => {
      if (playing === a.uuid) playing = null;
      position = { ...position, [a.uuid]: 0 };
      _savePosition(a.uuid, 0);
    };
    return el;
  }

  async function toggle(a) {
    if (playing === a.uuid) { audio?.pause(); playing = null; return; }
    const el = _ensureAudio(a);
    const from = position[a.uuid] || 0;
    if (Math.abs(el.currentTime - from) > 0.5) el.currentTime = from;
    try {
      await el.play();
      playing = a.uuid;
    } catch {
      playing = null;
    }
  }

  /** Jump to a time (seconds). Plays when asked, or when this one was already playing. */
  export function seek(a, secs, play = false) {
    const t = Math.max(0, Math.min(total(a) || secs, secs));
    position = { ...position, [a.uuid]: t };
    if (audio && audioUuid === a.uuid) audio.currentTime = t;
    else _savePosition(a.uuid, t, total(a));
    if (play && playing !== a.uuid) toggle(a);
  }

  function cycleRate() {
    const next = RATES[(RATES.indexOf($voicePlaybackRate || 1) + 1) % RATES.length];
    voicePlaybackRate.set(next);
    if (audio) audio.playbackRate = next;
  }

  // ── Scrubbing on the waveform ─────────────────────────────────────
  let scrubbing = null;
  function scrubAt(e, a, el) {
    const r = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    seek(a, frac * total(a));
  }
  function scrubStart(e, a) {
    if (!total(a)) return;
    const el = e.currentTarget;
    scrubbing = a.uuid;
    el.setPointerCapture?.(e.pointerId);
    scrubAt(e, a, el);
  }
  function scrubMove(e, a) { if (scrubbing === a.uuid) scrubAt(e, a, e.currentTarget); }
  function scrubEnd() { scrubbing = null; }
  function scrubKey(e, a) {
    const step = e.shiftKey ? 30 : 5;
    const now = position[a.uuid] || 0;
    if (e.key === 'ArrowRight') { e.preventDefault(); seek(a, now + step); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(a, now - step); }
    else if (e.key === 'Home') { e.preventDefault(); seek(a, 0); }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(a); }
  }

  // ── Timestamped transcripts ───────────────────────────────────────
  // Long transcripts show a few lines: the first ones, or the ones around what's playing.
  const SHORT = 6;
  let expanded = {};
  function visibleSegments(a, at, isPlaying, open) {
    const segs = a.segments || [];
    if (open || segs.length <= SHORT + 2) return segs.map((s, i) => ({ s, i }));
    const cur = isPlaying || at > 0 ? Math.max(0, segmentAt(segs, at)) : 0;
    const from = Math.max(0, Math.min(segs.length - SHORT, cur - 1));
    return segs.slice(from, from + SHORT).map((s, j) => ({ s, i: from + j }));
  }

  // ── Waveforms for recordings saved without one ────────────────────
  const _asked = new Set();
  $: for (const a of notes) {
    if (!a.waveform && !waves[a.uuid] && !_asked.has(a.uuid)) {
      _asked.add(a.uuid);
      fetchAttachmentBlob(a.url).then(waveformFromBlob).then((bars) => {
        if (!bars) return;
        waves = { ...waves, [a.uuid]: bars };
        if (editable) dispatch('waveform', { uuid: a.uuid, waveform: bars });
      }).catch(() => {});
    }
  }
  const FLAT = Array(WAVEFORM_BARS).fill(18);
  const barsFor = (a, w = waves) => a.waveform || w[a.uuid] || FLAT;

  onDestroy(() => {
    if (audio) { _savePosition(audioUuid, audio.currentTime, durations[audioUuid]); audio.pause(); }
  });
</script>

{#if notes.length}
  <ul class="vn">
    {#each notes as a (a.uuid)}
      {@const len = total(a, durations)}
      {@const bars = barsFor(a, waves)}
      {@const at = position[a.uuid] || 0}
      {@const frac = len ? Math.min(1, at / len) : 0}
      <li class="vn-item" class:active={playing === a.uuid}>
        <div class="vn-row">
          <button class="vn-play" on:click={() => toggle(a)} aria-label={playing === a.uuid ? $_('voice.pause') : $_('voice.play')}>
            <span class="material-symbols-rounded fill">{playing === a.uuid ? 'pause' : 'play_arrow'}</span>
          </button>
          <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
          <div class="vn-wave" role="slider" tabindex="0" aria-label={$_('voice.position')}
            aria-valuemin="0" aria-valuemax={Math.round(len)} aria-valuenow={Math.round(at)} aria-valuetext={formatDuration(at * 1000)}
            on:pointerdown={(e) => scrubStart(e, a)} on:pointermove={(e) => scrubMove(e, a)}
            on:pointerup={scrubEnd} on:pointercancel={scrubEnd} on:keydown={(e) => scrubKey(e, a)}>
            {#each bars as h, i (i)}
              <span class:played={(i + 0.5) / bars.length <= frac} style="height:{Math.max(8, h)}%"></span>
            {/each}
          </div>
          <span class="vn-time">
            {at > 0 || playing === a.uuid ? `${formatDuration(at * 1000)} / ${formatDuration(len * 1000)}` : formatDuration(len * 1000)}
          </span>
          <button class="vn-rate" on:click={cycleRate} title={$_('voice.speed')} aria-label={$_('voice.speed')}>{$voicePlaybackRate || 1}×</button>
          {#if editable}
            <button class="vn-x" on:click={() => dispatch('remove', a.uuid)} aria-label={$_('voice.remove')}>
              <span class="material-symbols-rounded">close</span>
            </button>
          {/if}
        </div>
        {#if a.summary}
          <div class="vn-sum">
            <span class="vn-sum-head"><span class="material-symbols-rounded">auto_awesome</span>{$_('trace_extract.summary')}</span>
            <ul class="vn-sum-list">
              {#each summaryLines(a.summary) as line}<li>{line}</li>{/each}
            </ul>
          </div>
          <div class="vn-actions">
            {#if editable}
              <button class="vn-link" on:click={() => dispatch('addtext', a.summary)}>
                <span class="material-symbols-rounded">note_add</span>{$_('trace_extract.add_to_note')}
              </button>
            {/if}
            {#if a.extracted_text}
              <button class="vn-link" on:click={() => toggleTranscript(a.uuid)}>
                <span class="material-symbols-rounded">{showTranscript[a.uuid] ? 'unfold_less' : 'notes'}</span>
                {showTranscript[a.uuid] ? $_('trace_extract.hide_transcript') : $_('trace_extract.show_transcript')}
              </button>
            {/if}
            {#if canSummarize && editable}
              <button class="vn-link vn-quiet" on:click={() => dispatch('summarize', a)} disabled={!!busy[a.uuid]}>
                <span class="material-symbols-rounded" class:spin={!!busy[a.uuid]}>{busy[a.uuid] ? 'progress_activity' : 'refresh'}</span>
                {busy[a.uuid] ? $_(busyLabel(busy[a.uuid])) : $_('trace_extract.summarize_again')}
              </button>
            {/if}
          </div>
        {/if}
        {#if a.extracted_text && (!a.summary || showTranscript[a.uuid])}
          {#if a.segments?.length}
            {@const cur = playing === a.uuid || at > 0 ? segmentAt(a.segments, at) : -1}
            <ol class="vn-segs">
              {#each visibleSegments(a, at, playing === a.uuid, expanded[a.uuid]) as { s, i } (i)}
                <li>
                  <button class="vn-seg" class:current={i === cur} on:click={() => seek(a, s.start, true)}
                    aria-label={$_('voice.play_from', { values: { time: formatDuration(s.start * 1000) } })}>
                    <span class="vn-ts">{formatDuration(s.start * 1000)}</span><span class="vn-line">{s.text}</span>
                  </button>
                </li>
              {/each}
            </ol>
            {#if a.segments.length > SHORT + 2}
              <button class="vn-link" on:click={() => expanded = { ...expanded, [a.uuid]: !expanded[a.uuid] }}>
                <span class="material-symbols-rounded">{expanded[a.uuid] ? 'unfold_less' : 'unfold_more'}</span>
                {expanded[a.uuid] ? $_('voice.show_less') : $_('voice.show_all', { values: { count: a.segments.length } })}
              </button>
            {/if}
          {:else}
            <p class="vn-text">{a.extracted_text}</p>
          {/if}
          {#if !a.summary}
            <div class="vn-actions">
              {#if editable}
                <button class="vn-link" on:click={() => dispatch('addtext', a.extracted_text)}>
                  <span class="material-symbols-rounded">note_add</span>{$_('trace_extract.add_to_note')}
                </button>
              {/if}
              {#if canSummarize && editable && worthSummarizing(a.extracted_text)}
                <button class="vn-link" on:click={() => dispatch('summarize', a)} disabled={!!busy[a.uuid]}>
                  <span class="material-symbols-rounded" class:spin={!!busy[a.uuid]}>{busy[a.uuid] ? 'progress_activity' : 'auto_awesome'}</span>
                  {busy[a.uuid] ? $_(busyLabel(busy[a.uuid])) : $_('trace_extract.summarize')}
                </button>
              {/if}
            </div>
          {/if}
        {/if}
        {#if !a.extracted_text && !a.summary && canTranscribe && editable}
          <div class="vn-actions">
            <button class="vn-link" on:click={() => dispatch('transcribe', a)} disabled={!!busy[a.uuid]}>
              <span class="material-symbols-rounded" class:spin={busy[a.uuid] === 'transcribing'}>{busy[a.uuid] === 'transcribing' ? 'progress_activity' : 'subtitles'}</span>
              {busy[a.uuid] === 'transcribing' ? $_('trace_extract.transcribing') : $_('trace_extract.transcribe')}
            </button>
            {#if canSummarize && longEnoughToSummarize(a.duration_ms)}
              <button class="vn-link" on:click={() => dispatch('summarize', a)} disabled={!!busy[a.uuid]}>
                <span class="material-symbols-rounded" class:spin={busy[a.uuid] === 'summarizing'}>{busy[a.uuid] === 'summarizing' ? 'progress_activity' : 'auto_awesome'}</span>
                {busy[a.uuid] === 'summarizing' ? $_('trace_extract.summarizing') : $_('trace_extract.summarize')}
              </button>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .vn { list-style: none; display: flex; flex-direction: column; gap: 8px; margin: 0 0 14px; }
  .vn-item { padding: 8px 10px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--text-1) 6%, transparent); }
  .vn-row { display: flex; align-items: center; gap: 10px; }
  .vn-play { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--accent); color: var(--accent-text, #0a0b0f); flex-shrink: 0; }
  .vn-wave {
    flex: 1; min-width: 0; height: 34px; display: flex; align-items: center; gap: 2px;
    cursor: pointer; touch-action: none; border-radius: 6px; outline: none;
  }
  .vn-wave:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
  .vn-wave span { flex: 1; min-width: 1px; border-radius: 2px; background: color-mix(in srgb, var(--text-1) 22%, transparent); transition: background 120ms; }
  .vn-wave span.played { background: var(--accent); }
  .vn-time { font-size: 12.5px; color: var(--text-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .vn-rate {
    min-width: 40px; height: 26px; padding: 0 6px; border-radius: 13px; font-size: 12px; font-weight: 600;
    color: var(--text-2); background: color-mix(in srgb, var(--text-1) 8%, transparent); font-variant-numeric: tabular-nums;
  }
  .vn-rate:hover { color: var(--text-1); }
  .vn-x { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
  .vn-x:hover { color: var(--text-1); background: color-mix(in srgb, var(--text-1) 8%, transparent); }
  .vn-segs { list-style: none; margin: 8px 0 2px; padding: 0; display: flex; flex-direction: column; }
  .vn-seg {
    width: 100%; display: flex; gap: 10px; align-items: baseline; text-align: left;
    padding: 4px 6px; border-radius: 8px; font-size: 14px; line-height: 1.5; color: var(--text-1);
    transition: background 120ms;
  }
  .vn-seg:hover { background: color-mix(in srgb, var(--text-1) 7%, transparent); }
  .vn-seg.current { background: var(--accent-dim); }
  .vn-seg.current .vn-ts { color: var(--accent); }
  .vn-ts { flex-shrink: 0; min-width: 38px; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--text-3); }
  .vn-line { flex: 1; min-width: 0; }
  .vn-text { margin: 8px 2px 2px; font-size: 14px; line-height: 1.5; color: var(--text-1); white-space: pre-wrap; }
  /* Trace's summary reads first: a tinted block with the bullets it wrote. */
  .vn-sum {
    margin: 8px 2px 2px; padding: 9px 11px; border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .vn-sum-head {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--accent);
  }
  .vn-sum-head .material-symbols-rounded { font-size: 14px; }
  .vn-sum-list { margin: 6px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
  .vn-sum-list li { position: relative; padding-left: 15px; font-size: 14px; line-height: 1.5; color: var(--text-1); }
  .vn-sum-list li::before {
    content: ''; position: absolute; left: 3px; top: 8px;
    width: 5px; height: 5px; border-radius: 50%; background: var(--accent);
  }
  .vn-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; }
  .vn-quiet { color: var(--text-3); }
  .vn-quiet:hover:not(:disabled) { color: var(--text-1); background: color-mix(in srgb, var(--text-1) 8%, transparent); }
  .vn-link { display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; padding: 4px 6px; border-radius: 8px; font-size: 13px; color: var(--accent); }
  .vn-link:hover:not(:disabled) { background: var(--accent-dim); }
  .vn-link .material-symbols-rounded { font-size: 17px; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 420px) { .vn-rate { min-width: 34px; } .vn-row { gap: 8px; } }
</style>
