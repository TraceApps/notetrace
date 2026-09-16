<script>
  /**
   * DuePicker: quick due dates for a checklist item, a calendar, and Clear.
   * With `repeats` on, a Repeat row below: picking a repeat dispatches
   * `repeat` without closing (a task with no date yet starts today), so a
   * date and its repeat can be set in one visit.
   */
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import DatePicker from '../ui/DatePicker.svelte';
  import { todayStr, addDays } from '../../lib/due-dates.js';
  import { TASK_REPEATS } from '../../../server/lib/task-rules.js';

  export let value = null;
  export let repeat = null;
  export let repeats = false;
  const dispatch = createEventDispatcher();
  let calendar = false;

  $: today = todayStr();
  $: nextMonday = (() => { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; return addDays(today, add); })();
  const set = (v) => dispatch('select', v);
  const setRepeat = (r) => { repeat = r; dispatch('repeat', r); };
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
  {#if repeats}
    <div class="dp-repeat">
      <p class="dp-sub"><span class="material-symbols-rounded">repeat</span>{$_('due.repeat')}</p>
      <div class="dp-chips" role="radiogroup" aria-label={$_('due.repeat')}>
        <button role="radio" aria-checked={!repeat} class:on={!repeat} on:click={() => setRepeat(null)}>{$_('due.repeat_none')}</button>
        {#each TASK_REPEATS as r}
          <button role="radio" aria-checked={repeat === r} class:on={repeat === r} on:click={() => setRepeat(r)}>{$_(`due.repeat_${r}`)}</button>
        {/each}
      </div>
    </div>
  {/if}
  {#if value}
    <button class="dp-row dp-clear" on:click={() => set(null)}><span class="material-symbols-rounded">event_busy</span>{$_('due.clear')}</button>
  {/if}
</div>

<style>
  .due-picker { display: flex; flex-direction: column; gap: 2px; min-width: 220px; max-width: 290px; }
  .dp-title { font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 4px; }
  .dp-row { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 10px; border-radius: 10px; font-size: 14px; color: var(--text-1); text-align: left; }
  .dp-row:hover { background: color-mix(in srgb, var(--text-1) 7%, transparent); }
  .dp-row .material-symbols-rounded { font-size: 20px; color: var(--accent); }
  .dp-clear, .dp-clear .material-symbols-rounded { color: var(--text-3); }
  .dp-repeat { margin: 6px 0 2px; padding: 8px 4px 2px; border-top: 1px solid var(--border); }
  .dp-sub { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text-2); margin: 0 6px 8px; }
  .dp-sub .material-symbols-rounded { font-size: 16px; color: var(--accent); }
  .dp-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px 6px; }
  .dp-chips button {
    height: 32px; padding: 0 11px; border-radius: var(--radius-full);
    font-size: 13px; font-weight: 600; color: var(--text-2);
    background: color-mix(in srgb, var(--text-1) 6%, transparent);
    border: 1px solid transparent;
  }
  .dp-chips button:hover { color: var(--text-1); background: color-mix(in srgb, var(--text-1) 10%, transparent); }
  .dp-chips button.on { color: var(--accent); background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
</style>
