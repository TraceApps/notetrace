<script>
  /** DuePicker: quick due dates for a checklist item, a calendar, and Clear. */
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import DatePicker from '../ui/DatePicker.svelte';
  import { todayStr, addDays } from '../../lib/due-dates.js';

  export let value = null;
  const dispatch = createEventDispatcher();
  let calendar = false;

  $: today = todayStr();
  $: nextMonday = (() => { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; return addDays(today, add); })();
  const set = (v) => dispatch('select', v);
</script>

<div class="due-picker">
  <p class="dp-title">{$_('due.title')}</p>
  {#if calendar}
    <DatePicker value={value || today} on:select={(e) => set(e.detail)} />
  {:else}
    <button class="dp-row" on:click={() => set(today)}><span class="material-symbols-rounded">today</span>{$_('due.today')}</button>
    <button class="dp-row" on:click={() => set(addDays(today, 1))}><span class="material-symbols-rounded">event_upcoming</span>{$_('due.tomorrow')}</button>
    <button class="dp-row" on:click={() => set(nextMonday)}><span class="material-symbols-rounded">date_range</span>{$_('due.next_week')}</button>
    <button class="dp-row" on:click={() => calendar = true}><span class="material-symbols-rounded">calendar_month</span>{$_('due.pick')}</button>
  {/if}
  {#if value}
    <button class="dp-row dp-clear" on:click={() => set(null)}><span class="material-symbols-rounded">event_busy</span>{$_('due.clear')}</button>
  {/if}
</div>

<style>
  .due-picker { display: flex; flex-direction: column; gap: 2px; min-width: 220px; }
  .dp-title { font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 4px; }
  .dp-row { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 10px; border-radius: 10px; font-size: 14px; color: var(--text-1); text-align: left; }
  .dp-row:hover { background: color-mix(in srgb, var(--text-1) 7%, transparent); }
  .dp-row .material-symbols-rounded { font-size: 20px; color: var(--accent); }
  .dp-clear, .dp-clear .material-symbols-rounded { color: var(--text-3); }
</style>
