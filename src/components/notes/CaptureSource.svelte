<script>
  import { _ } from 'svelte-i18n';
  import { captureSource } from '../../../server/lib/capture-state.js';
  export let note = null;
  $: source = captureSource(note);
</script>

{#if source}
  <aside class="capture-source">
    <a href={source.url} target="_blank" rel="noopener noreferrer">{$_('capture.source')}</a>
    <span>{source.subject}</span>
    <small>{source.sender} · {source.date}</small>
    {#if source.context_md}<details><summary>{$_('capture.context')}</summary><pre>{source.context_md}</pre></details>{/if}
    {#if source.deadline_quote}<blockquote>{source.deadline_quote}</blockquote>{/if}
  </aside>
{/if}

<style>
  .capture-source { margin: 12px 0; padding: 12px; border: 1px solid var(--border); border-radius: 8px; display: grid; gap: 4px; overflow-wrap: anywhere; }
  small { opacity: .7; }
  pre { white-space: pre-wrap; font: inherit; }
  blockquote { margin: 6px 0 0; padding-left: 10px; border-left: 2px solid currentColor; opacity: .7; }
</style>
