<script>
  /**
   * Shopping: the CookTrace shopping list, live, grouped by aisle the way
   * CookTrace shows it. Tick items off, add a few, and clear what's bought;
   * everything goes straight back to CookTrace. Without a connection it shows
   * the last list it loaded, and changes wait until the connection is back.
   */
  import { onMount, onDestroy } from 'svelte';
  import { slide, fade } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { _ } from 'svelte-i18n';
  import { push } from 'svelte-spa-router';
  import { bannerStyle, disableAnimations } from '../stores/settings.js';
  import {
    cooktraceLink, cooktraceOn, loadCooktraceLink, cooktraceAvailable,
    shopping, loadShopping, setShoppingChecked, addShoppingItem, clearCheckedShopping, shoppingQueue,
  } from '../lib/cooktrace.js';
  import { applyPending, groupShopping, amountLabel } from '../lib/shopping-groups.js';
  import { relativeTime } from '../lib/relative-time.js';
  import { confirmDialog } from '../stores/confirmDialog.js';

  let newName = '';
  let showChecked = false;
  let addInput;

  $: linked = cooktraceOn($cooktraceLink);
  // What CookTrace last said, with anything still on its way laid over it.
  $: shown = applyPending($shopping.items || [], ($shopping.pending, shoppingQueue()));
  $: ({ groups, checked } = groupShopping(shown));
  $: openCount = shown.filter(i => !i.checked).length;
  $: ms = $disableAnimations ? 0 : 180;

  onMount(async () => {
    const link = await loadCooktraceLink();
    if (cooktraceOn(link)) loadShopping();
    document.addEventListener('visibilitychange', onVisible);
  });
  onDestroy(() => document.removeEventListener('visibilitychange', onVisible));
  function onVisible() { if (document.visibilityState === 'visible' && linked) loadShopping(); }

  async function add() {
    const name = newName.trim();
    if (!name) return;
    newName = '';
    addInput?.focus();
    await addShoppingItem(name);
  }

  async function clearChecked() {
    const ok = await confirmDialog({
      title: $_('shopping.clear_title'),
      message: $_('shopping.clear_message', { values: { n: checked.length } }),
      confirmText: $_('shopping.clear'),
      cancelText: $_('common.cancel'),
    });
    if (ok) clearCheckedShopping();
  }

  $: cooktraceUrl = $cooktraceLink?.url ? `${$cooktraceLink.url.replace(/\/+$/, '')}/#/shopping` : null;
</script>

<div class="page-shell shopping-page">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('shopping.title')}</h1>
    {#if linked}
      <div class="header-actions">
        <button class="btn-icon header-btn" on:click={() => loadShopping()} disabled={$shopping.loading}
          title={$_('shopping.refresh')} aria-label={$_('shopping.refresh')}>
          <span class="material-symbols-rounded" class:spin={$shopping.loading}>refresh</span>
        </button>
        {#if cooktraceUrl}
          <a class="btn-icon header-btn" href={cooktraceUrl} target="_blank" rel="noopener" title={$_('shopping.open_cooktrace')} aria-label={$_('shopping.open_cooktrace')}>
            <span class="material-symbols-rounded">open_in_new</span>
          </a>
        {/if}
      </div>
    {/if}
  </header>

  <div class="shopping-body">
    {#if $cooktraceLink === null}
      <div class="skeleton" aria-hidden="true">{#each Array(6) as _s}<div></div>{/each}</div>
    {:else if !linked}
      <div class="empty">
        <span class="material-symbols-rounded empty-icon">shopping_cart</span>
        <h2>{$_('shopping.not_linked_title')}</h2>
        <p>{cooktraceAvailable ? $_('shopping.not_linked_body') : $_('cooktrace.needs_server')}</p>
        {#if cooktraceAvailable}
          <button class="btn btn-primary" on:click={() => push('/settings/cooktrace')}>{$_('shopping.link')}</button>
        {/if}
      </div>
    {:else}
      <form class="quick-add" on:submit|preventDefault={add}>
        <span class="material-symbols-rounded">add_shopping_cart</span>
        <input bind:this={addInput} bind:value={newName} placeholder={$_('shopping.add_placeholder')} aria-label={$_('shopping.add_placeholder')} maxlength="200" enterkeyhint="done" />
        <button class="btn btn-primary qa-go" type="submit" disabled={!newName.trim()}>{$_('shopping.add')}</button>
      </form>

      {#if $shopping.offline || $shopping.pending || $shopping.error}
        <p class="status" class:bad={!!$shopping.error} role="status" transition:slide={{ duration: ms }}>
          <span class="material-symbols-rounded">{$shopping.error ? 'error' : $shopping.offline ? 'cloud_off' : 'cloud_upload'}</span>
          {#if $shopping.error}{$shopping.error}
          {:else if $shopping.offline}{$shopping.at ? $_('shopping.offline_from', { values: { when: relativeTime($shopping.at).toLowerCase() } }) : $_('shopping.offline')}{#if $shopping.pending}{' '}{$_('shopping.waiting', { values: { n: $shopping.pending } })}{/if}
          {:else}{$_('shopping.sending')}{/if}
        </p>
      {/if}

      {#if $shopping.items === null && $shopping.loading}
        <div class="skeleton" aria-hidden="true">{#each Array(6) as _s}<div></div>{/each}</div>
      {:else if !shown.length}
        <div class="empty" in:fade={{ duration: ms }}>
          <span class="material-symbols-rounded empty-icon">done_all</span>
          <h2>{$_('shopping.empty_title')}</h2>
          <p>{$_('shopping.empty_body')}</p>
        </div>
      {:else}
        {#if !openCount}
          <p class="all-done" in:fade={{ duration: ms }}><span class="material-symbols-rounded">celebration</span>{$_('shopping.all_done')}</p>
        {/if}
        {#each groups as g (g.key)}
          <section class="aisle" transition:slide={{ duration: ms }}>
            <h2 class="aisle-title">{g.aisle || $_('shopping.no_aisle')}<span class="count">{g.items.length}</span></h2>
            <ul class="items">
              {#each g.items as it (it.id)}
                <li class="item" class:pending={it.pending} animate:flip={{ duration: ms }} out:slide={{ duration: ms }}>
                  <button class="check" on:click={() => setShoppingChecked(it.id, true)} disabled={typeof it.id !== 'number'}
                    aria-label={$_('shopping.check', { values: { name: it.name } })}>
                    <span class="material-symbols-rounded">radio_button_unchecked</span>
                  </button>
                  <span class="name">{it.name}</span>
                  {#if amountLabel(it)}<span class="amount">{amountLabel(it)}</span>{/if}
                  {#if it.recipe_name}<span class="recipe" title={$_('shopping.from_recipe', { values: { name: it.recipe_name } })}><span class="material-symbols-rounded">menu_book</span>{it.recipe_name}</span>{/if}
                </li>
              {/each}
            </ul>
          </section>
        {/each}

        {#if checked.length}
          <section class="done-section">
            <div class="done-head">
              <button class="done-toggle" on:click={() => showChecked = !showChecked} aria-expanded={showChecked}>
                <span class="material-symbols-rounded" class:open={showChecked}>expand_more</span>
                {$_('shopping.checked', { values: { n: checked.length } })}
              </button>
              <button class="btn btn-secondary clear" on:click={clearChecked}>
                <span class="material-symbols-rounded">remove_done</span>{$_('shopping.clear')}
              </button>
            </div>
            {#if showChecked}
              <ul class="items" transition:slide={{ duration: ms }}>
                {#each checked as it (it.id)}
                  <li class="item done" class:pending={it.pending}>
                    <button class="check on" on:click={() => setShoppingChecked(it.id, false)} disabled={typeof it.id !== 'number'}
                      aria-label={$_('shopping.uncheck', { values: { name: it.name } })}>
                      <span class="material-symbols-rounded fill">check_circle</span>
                    </button>
                    <span class="name">{it.name}</span>
                    {#if amountLabel(it)}<span class="amount">{amountLabel(it)}</span>{/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/if}
      {/if}
    {/if}
  </div>
</div>

<style>
  .shopping-page .header-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; }
  .shopping-page .header-btn { border-radius: 12px; color: var(--text-2); display: flex; align-items: center; justify-content: center; }
  .shopping-page .header-btn:hover { background: color-mix(in srgb, var(--text-1) 10%, transparent); color: var(--text-1); }
  .page-header.banner-gradient .header-btn, .page-header.banner-animated .header-btn { color: rgba(255, 255, 255, 0.92); }
  .spin { animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }

  .shopping-body {
    display: flex; flex-direction: column; gap: 16px;
    width: 100%; max-width: 720px; margin: 0 auto;
    padding: 16px var(--page-px) calc(var(--nav-h) + var(--safe-bottom) + 96px);
  }
  .quick-add {
    height: 52px; display: flex; align-items: center; gap: 8px; padding: 0 6px 0 14px;
    background: var(--surface-1); border: 1px solid var(--border-strong); border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
  }
  .quick-add:focus-within { border-color: var(--accent); box-shadow: var(--shadow-md), 0 0 0 4px var(--accent-dim); }
  .quick-add > .material-symbols-rounded { color: var(--accent); font-size: 22px; }
  .quick-add input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--text-1); font-size: 15px; }
  .qa-go { height: 40px; }

  .status { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); padding: 0 4px; }
  .status .material-symbols-rounded { font-size: 18px; color: var(--text-3); }
  .status.bad, .status.bad .material-symbols-rounded { color: var(--danger); }

  .aisle { display: flex; flex-direction: column; gap: 6px; }
  .aisle-title {
    display: flex; align-items: center; gap: 8px; padding: 4px 4px 0;
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3);
  }
  .count { font-weight: 600; opacity: 0.7; }
  .items { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .item {
    display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 4px 12px 4px 4px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-md);
  }
  .item.pending { border-style: dashed; }
  .check { width: 44px; height: 44px; flex-shrink: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
  .check .material-symbols-rounded { font-size: 24px; transition: transform 160ms ease; }
  .check:hover:not(:disabled) { color: var(--accent); }
  .check:hover:not(:disabled) .material-symbols-rounded { transform: scale(1.1); }
  .check.on { color: var(--accent); }
  .name { flex: 1; min-width: 0; font-size: 15px; color: var(--text-1); overflow-wrap: anywhere; }
  .amount { flex-shrink: 0; font-size: 13px; font-weight: 600; color: var(--text-2); }
  .recipe {
    flex-shrink: 1; min-width: 0; max-width: 40%; display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: var(--radius-full); background: var(--accent-dim); color: var(--accent);
    font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .recipe .material-symbols-rounded { font-size: 14px; }
  .item.done .name { color: var(--text-3); text-decoration: line-through; }

  .all-done { display: flex; align-items: center; gap: 8px; justify-content: center; color: var(--text-2); font-size: 14px; padding: 8px; }
  .all-done .material-symbols-rounded { color: var(--accent); }
  .done-section { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
  .done-head { display: flex; align-items: center; gap: 8px; }
  .done-toggle { display: inline-flex; align-items: center; gap: 6px; flex: 1; min-height: 40px; font-size: 13px; font-weight: 600; color: var(--text-2); text-align: left; }
  .done-toggle .material-symbols-rounded { transition: transform 180ms ease; }
  .done-toggle .material-symbols-rounded.open { transform: rotate(180deg); }
  .clear { height: 36px; font-size: 13px; }
  .clear .material-symbols-rounded { font-size: 18px; }
  .fill { font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24; }

  .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; margin: 8vh auto 0; max-width: 380px; }
  .empty-icon { font-size: 48px; color: var(--accent); margin-bottom: 8px; }
  .empty h2 { font-family: var(--font-note-title); font-weight: 500; font-size: 24px; }
  .empty p { color: var(--text-2); font-size: 15px; line-height: 1.5; }
  .empty .btn { margin-top: 8px; }
  .skeleton { display: flex; flex-direction: column; gap: 8px; }
  .skeleton div { height: 52px; border-radius: var(--radius-md); background: var(--surface-1); border: 1px solid var(--border); animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.55; } }
  @media (prefers-reduced-motion: reduce) { .skeleton div { animation: none; } }
</style>
