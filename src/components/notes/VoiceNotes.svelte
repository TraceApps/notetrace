<script>
  /**
   * VoiceNotes: a note's voice recordings, each with a player and its
   * transcript (or a Transcribe button when Trace can do it).
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { formatDuration } from '../../lib/voice-recorder.js';

  export let notes = [];          // audio attachments
  export let editable = false;
  export let canTranscribe = false;
  export let busy = {};           // uuid -> true while transcribing

  const dispatch = createEventDispatcher();
  let playing = null;
  let audio = null;
  let progress = 0;

  function toggle(a) {
    if (playing === a.uuid) { audio?.pause(); playing = null; return; }
    audio?.pause();
    audio = new Audio(resolveAssetUrl(a.url));
    audio.ontimeupdate = () => { progress = audio.duration ? audio.currentTime / audio.duration : 0; };
    audio.onended = () => { playing = null; progress = 0; };
    audio.play().then(() => { playing = a.uuid; }).catch(() => { playing = null; });
  }
  onDestroy(() => audio?.pause());
</script>

{#if notes.length}
  <ul class="vn">
    {#each notes as a (a.uuid)}
      <li class="vn-item">
        <div class="vn-row">
          <button class="vn-play" on:click={() => toggle(a)} aria-label={playing === a.uuid ? $_('voice.pause') : $_('voice.play')}>
            <span class="material-symbols-rounded fill">{playing === a.uuid ? 'pause' : 'play_arrow'}</span>
          </button>
          <div class="vn-meta">
            <span class="vn-label">{$_('voice.voice_note')}</span>
            <div class="vn-bar"><span style="width:{playing === a.uuid ? progress * 100 : 0}%"></span></div>
          </div>
          <span class="vn-time">{formatDuration(a.duration_ms)}</span>
          {#if editable}
            <button class="vn-x" on:click={() => dispatch('remove', a.uuid)} aria-label={$_('voice.remove')}>
              <span class="material-symbols-rounded">close</span>
            </button>
          {/if}
        </div>
        {#if a.extracted_text}
          <p class="vn-text">{a.extracted_text}</p>
          {#if editable}
            <button class="vn-link" on:click={() => dispatch('addtext', a.extracted_text)}>
              <span class="material-symbols-rounded">note_add</span>{$_('trace_extract.add_to_note')}
            </button>
          {/if}
        {:else if canTranscribe && editable}
          <button class="vn-link" on:click={() => dispatch('transcribe', a)} disabled={busy[a.uuid]}>
            <span class="material-symbols-rounded" class:spin={busy[a.uuid]}>{busy[a.uuid] ? 'progress_activity' : 'subtitles'}</span>
            {busy[a.uuid] ? $_('trace_extract.transcribing') : $_('trace_extract.transcribe')}
          </button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .vn { list-style: none; display: flex; flex-direction: column; gap: 8px; margin: 0 0 14px; }
  .vn-item { padding: 8px 10px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--text-1) 6%, transparent); }
  .vn-row { display: flex; align-items: center; gap: 10px; }
  .vn-play { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--accent); color: var(--bg, #0a0b0f); flex-shrink: 0; }
  .vn-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .vn-label { font-size: 13px; color: var(--text-2); }
  .vn-bar { height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--text-1) 12%, transparent); overflow: hidden; }
  .vn-bar span { display: block; height: 100%; background: var(--accent); }
  .vn-time { font-size: 13px; color: var(--text-2); font-variant-numeric: tabular-nums; }
  .vn-x { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
  .vn-x:hover { color: var(--text-1); background: color-mix(in srgb, var(--text-1) 8%, transparent); }
  .vn-text { margin: 8px 2px 2px; font-size: 14px; line-height: 1.5; color: var(--text-1); white-space: pre-wrap; }
  .vn-link { display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; padding: 4px 6px; border-radius: 8px; font-size: 13px; color: var(--accent); }
  .vn-link:hover:not(:disabled) { background: var(--accent-dim); }
  .vn-link .material-symbols-rounded { font-size: 17px; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
