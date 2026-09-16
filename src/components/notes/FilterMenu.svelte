<script>
  // One filter group's choices (Type, Color, or Label), picked several at a time.
  // The same menu for every group, in a popover or, on a phone, a bottom sheet.
  import { createEventDispatcher } from 'svelte';
  import { fly } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { disableAnimations } from '../../stores/settings.js';

  /** [{ value, label, icon?, dot? }] */
  export let options = [];
  export let selected = [];
  export let title = '';
  /** 'list' (rows with a check) or 'swatches' (colour circles with names). */
  export let layout = 'list';

  const dispatch = createEventDispatcher();
  $: chosen = new Set(selected);
  const toggle = (value) => dispatch('toggle', value);
</script>

<div class="fm" class:swatches={layout === 'swatches'}>
  <div class="fm-head">
    <span class="fm-title">{title}</span>
    {#if selected.length}
      <button type="button" class="fm-clear" on:click={() => dispatch('clear')}>{$_('filters.clear_group')}</button>
    {/if}
  </div>
  <div class="fm-options" role="group" aria-label={title}>
    {#each options as o, i (o.value)}
      <button type="button" class="fm-opt" class:on={chosen.has(o.value)} aria-pressed={chosen.has(o.value)}
        on:click={() => toggle(o.value)}
        in:fly={{ y: 6, duration: $disableAnimations ? 0 : 160, delay: $disableAnimations ? 0 : Math.min(i, 12) * 18 }}>
        {#if layout === 'swatches'}
          <span class="fm-swatch" style="background:{o.dot}">
            {#if chosen.has(o.value)}<span class="material-symbols-rounded">check</span>{/if}
          </span>
          <span class="fm-name">{o.label}</span>
        {:else}
          {#if o.icon}<span class="material-symbols-rounded fm-icon">{o.icon}</span>{/if}
          {#if o.dot}<span class="fm-dot" style="background:{o.dot}"></span>{/if}
          <span class="fm-name">{o.label}</span>
          <span class="material-symbols-rounded fm-check" aria-hidden="true">{chosen.has(o.value) ? 'check_circle' : 'radio_button_unchecked'}</span>
        {/if}
      </button>
    {/each}
  </div>
  <button type="button" class="btn btn-primary fm-done" on:click={() => dispatch('done')}>{$_('common.done')}</button>
</div>

<style>
  .fm { display: flex; flex-direction: column; gap: 8px; width: 280px; max-width: 100%; max-height: min(70vh, 520px); }
  .fm.swatches { width: 320px; }
  .fm-head { display: flex; align-items: center; justify-content: space-between; min-height: 32px; padding: 0 4px; }
  .fm-title { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }
  .fm-clear { font-size: 13px; font-weight: 600; color: var(--accent); padding: 6px 8px; border-radius: 8px; }
  .fm-clear:hover { background: var(--accent-dim); }
  .fm-options { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; overscroll-behavior: contain; min-height: 0; }
  .fm-opt {
    display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 10px; border-radius: 12px;
    color: var(--text-1); font-size: 15px; text-align: left;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .fm-opt:hover { background: color-mix(in srgb, var(--text-1) 7%, transparent); }
  .fm-opt.on { background: var(--accent-dim); }
  .fm-icon { font-size: 20px; color: var(--text-2); }
  .fm-opt.on .fm-icon { color: var(--accent); }
  .fm-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .fm-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fm-check { font-size: 20px; color: var(--text-3); transition: color var(--dur-fast), transform 160ms ease; }
  .fm-opt.on .fm-check { color: var(--accent); transform: scale(1.06); }

  .swatches .fm-options { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
  .swatches .fm-opt { flex-direction: column; justify-content: center; gap: 6px; min-height: 72px; padding: 8px 2px; font-size: 12px; }
  .swatches .fm-name { text-align: center; color: var(--text-2); width: 100%; }
  .swatches .fm-opt.on { background: none; }
  .swatches .fm-opt.on .fm-name { color: var(--text-1); font-weight: 600; }
  .fm-swatch {
    width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
    transition: transform 160ms ease, box-shadow 160ms ease;
  }
  .fm-opt:hover .fm-swatch { transform: scale(1.06); }
  .fm-opt.on .fm-swatch { box-shadow: 0 0 0 2px var(--surface-1), 0 0 0 4px var(--accent); }
  .fm-swatch .material-symbols-rounded { font-size: 20px; color: #16151c; font-weight: 700; }
  .fm-done { height: 40px; margin-top: 4px; }
  @media (min-width: 601px) { .fm-done { display: none; } }
</style>
