<script>
  /**
   * CooktraceSend: send a checklist's unchecked items to the linked
   * CookTrace shopping list, with the option to check them off here after.
   */
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { sendToCooktrace } from '../../lib/cooktrace.js';
  import { showSuccess, showError } from '../../stores/toast.js';

  export let items = [];
  export let canCheck = true;

  const dispatch = createEventDispatcher();
  const SHOWN = 8;
  let busy = false;
  let checkAfter = false;

  $: open = items.filter(i => !i.checked && String(i.text || '').trim());

  async function send() {
    if (busy || !open.length) return;
    busy = true;
    const sending = open;
    try {
      const r = await sendToCooktrace(sending);
      const added = r.added?.length || 0;
      const skipped = r.skipped?.length || 0;
      if (added && skipped) showSuccess($_('cooktrace.sent_some_skipped', { values: { count: added, skipped } }));
      else if (skipped) showSuccess($_('cooktrace.all_skipped', { values: { count: skipped } }));
      else showSuccess($_('cooktrace.sent', { values: { count: added } }));
      // Added or already there, every sent item is on the CookTrace list now.
      const onList = new Set((r.names || []).map(n => n.toLowerCase()));
      dispatch('sent', { uuids: checkAfter ? sending.filter(i => onList.has(_clean(i.text))).map(i => i.uuid) : [] });
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
    }
  }

  function _clean(t) {
    return String(t || '').replace(/\[\[([^[\]]+)\]\]/g, '$1').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200).toLowerCase();
  }
</script>

<div class="cs">
  <p class="cs-title">{$_('cooktrace.send_title')}</p>
  {#if !open.length}
    <p class="cs-desc">{$_('cooktrace.nothing')}</p>
  {:else}
    <p class="cs-desc">{$_('cooktrace.send_desc')}</p>
    <ul class="cs-list">
      {#each open.slice(0, SHOWN) as it (it.uuid)}
        <li><span class="material-symbols-rounded">add_shopping_cart</span><span class="name">{it.text}</span></li>
      {/each}
      {#if open.length > SHOWN}
        <li class="more">{$_('cooktrace.more', { values: { count: open.length - SHOWN } })}</li>
      {/if}
    </ul>
    {#if canCheck}
      <label class="cs-check">
        <input type="checkbox" bind:checked={checkAfter} />
        <span>{$_('cooktrace.check_after')}</span>
      </label>
    {/if}
    <div class="cs-buttons">
      <button class="btn btn-secondary" on:click={() => dispatch('close')}>{$_('common.cancel')}</button>
      <button class="btn btn-primary" on:click={send} disabled={busy}>
        {busy ? $_('cooktrace.sending') : $_('cooktrace.send_count', { values: { count: Math.min(open.length, 50) } })}
      </button>
    </div>
  {/if}
</div>

<style>
  .cs { display: flex; flex-direction: column; gap: 8px; width: 320px; max-width: 100%; }
  :global(.pop-panel.sheet) .cs { width: 100%; }
  .cs-title { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .cs-desc { font-size: 13px; color: var(--text-3); }
  .cs-list {
    list-style: none; display: flex; flex-direction: column; gap: 6px; max-height: 40vh; overflow: auto;
    list-style: none; display: flex; flex-direction: column; gap: 6px; max-height: 40dvh; overflow: auto;
    padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-md);
  }
  .cs-list li { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-1); min-width: 0; }
  .cs-list .material-symbols-rounded { font-size: 17px; color: var(--accent); flex-shrink: 0; }
  .cs-list .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cs-list .more { color: var(--text-3); font-size: 13px; padding-left: 25px; }
  .cs-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); min-height: 36px; cursor: pointer; }
  .cs-check input { width: 18px; height: 18px; accent-color: var(--accent); }
  .cs-buttons { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
  .cs-buttons .btn { height: 38px; }
</style>
