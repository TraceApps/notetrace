<script>
  import { tick } from 'svelte';
  import Dialog from './Dialog.svelte';
  import { confirmRequest } from '../../stores/confirmDialog.js';

  let open = false;
  let current = null;
  let text = '';
  let inputEl;

  $: if ($confirmRequest) {
    current = $confirmRequest;
    text = current.input?.value || '';
    open = true;
    if (current.input) tick().then(() => { inputEl?.focus(); inputEl?.select(); });
  }

  function finish(result) {
    const req = current;
    open = false;
    current = null;
    confirmRequest.set(null);
    if (req?.input) req.resolve?.(result ? (text.trim() || null) : null);
    else req?.resolve?.(result);
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (text.trim()) finish(true); }
  }
</script>

{#if current}
  <Dialog
    bind:open
    title={current.title}
    message={current.message}
    confirmText={current.confirmText}
    cancelText={current.cancelText}
    dangerous={current.dangerous}
    on:confirm={() => finish(true)}
    on:cancel={() => finish(false)}
  >
    {#if current.input}
      <input bind:this={inputEl} class="input dialog-input" type="text" bind:value={text}
        placeholder={current.input.placeholder} maxlength={current.input.maxlength}
        aria-label={current.input.label || current.title} on:keydown={onKey} />
    {/if}
  </Dialog>
{/if}

<style>
  .dialog-input { width: 100%; margin: 0 0 18px; }
</style>
