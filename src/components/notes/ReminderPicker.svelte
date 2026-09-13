<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import DateInput from '../ui/DateInput.svelte';
  import TimePicker from '../ui/TimePicker.svelte';
  import { timeFormat } from '../../stores/settings.js';
  import {
    REPEATS, reminderPresets, formatReminder, localTimeZone, parseUtc, toUtcString, nextOccurrence,
  } from '../../lib/reminders.js';

  /** Current reminder fields from the note (may be empty). */
  export let reminderAt = null;
  export let repeat = null;
  export let tz = null;

  const dispatch = createEventDispatcher();
  const pad = n => String(n).padStart(2, '0');

  const existing = parseUtc(reminderAt);
  const start = existing || reminderPresets()[0].date;
  let date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  let time = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  let repeatValue = repeat || '';
  let custom = !!existing;

  $: hour12 = $timeFormat === '24h' ? false : undefined;
  $: presets = reminderPresets();
  $: labels = { today: $_('reminders.today'), tomorrow: $_('reminders.tomorrow') };
  $: customDate = (() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
    const [y, m, d] = date.split('-').map(Number);
    const [h, min] = time.split(':').map(Number);
    return new Date(y, m - 1, d, h, min, 0, 0);
  })();
  $: customInPast = customDate && !repeatValue && customDate <= new Date();

  function emit(d) {
    if (!d) return;
    dispatch('set', {
      reminder_at: toUtcString(d),
      reminder_rrule: repeatValue || null,
      reminder_tz: localTimeZone(),
    });
  }
</script>

<div class="rp">
  <p class="rp-title">{$_('reminders.remind_me')}</p>

  {#if existing}
    <div class="rp-current">
      <span class="material-symbols-rounded">notifications</span>
      <span>{formatReminder(nextOccurrence(reminderAt, repeat, tz), { hour12, ...labels })}</span>
      {#if repeat}<span class="rp-repeat">{$_(`reminders.repeat_${repeat}`)}</span>{/if}
    </div>
  {/if}

  {#if !custom}
    <ul class="rp-presets">
      {#each presets as p (p.key)}
        <li>
          <button type="button" class="rp-preset" on:click={() => emit(p.date)}>
            <span>{$_(`reminders.preset_${p.key}`)}</span>
            <span class="rp-when">{formatReminder(p.date, { hour12, ...labels })}</span>
          </button>
        </li>
      {/each}
      <li>
        <button type="button" class="rp-preset" on:click={() => custom = true}>
          <span class="material-symbols-rounded">event</span>
          <span>{$_('reminders.pick_date_time')}</span>
        </button>
      </li>
    </ul>
  {:else}
    <div class="rp-custom">
      <DateInput bind:value={date} />
      <TimePicker value={time} on:change={(e) => time = e.detail} />
      <label class="rp-select">
        <span class="material-symbols-rounded">repeat</span>
        <select bind:value={repeatValue} aria-label={$_('reminders.repeat')}>
          <option value="">{$_('reminders.repeat_none')}</option>
          {#each REPEATS as r}<option value={r}>{$_(`reminders.repeat_${r}`)}</option>{/each}
        </select>
      </label>
      {#if customInPast}<p class="rp-warn">{$_('reminders.in_past')}</p>{/if}
      <div class="rp-actions">
        <button type="button" class="btn btn-secondary" on:click={() => custom = false}>{$_('common.back')}</button>
        <button type="button" class="btn btn-primary" disabled={!customDate || customInPast} on:click={() => emit(customDate)}>
          {$_('reminders.save')}
        </button>
      </div>
    </div>
  {/if}

  {#if existing}
    <button type="button" class="rp-remove" on:click={() => dispatch('clear')}>
      <span class="material-symbols-rounded">notifications_off</span>{$_('reminders.remove')}
    </button>
  {/if}
</div>

<style>
  .rp { display: flex; flex-direction: column; gap: 8px; width: 300px; max-width: 100%; }
  :global(.pop-panel.sheet) .rp { width: 100%; }
  .rp-title { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .rp-current {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 8px 10px; border-radius: 10px;
    background: var(--accent-dim); color: var(--accent);
    font-size: 14px; font-weight: 500;
  }
  .rp-current .material-symbols-rounded { font-size: 18px; }
  .rp-repeat { font-size: 12px; opacity: 0.8; }
  .rp-presets { list-style: none; margin: 0 -6px; }
  .rp-preset {
    width: 100%; min-height: 44px; padding: 0 8px;
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    border-radius: 10px; text-align: left; font-size: 14px; color: var(--text-1);
  }
  .rp-preset:hover { background: color-mix(in srgb, var(--text-1) 7%, transparent); }
  .rp-preset .material-symbols-rounded { font-size: 19px; color: var(--text-2); }
  .rp-preset:has(.material-symbols-rounded) { justify-content: flex-start; }
  .rp-when { font-size: 12px; color: var(--text-3); white-space: nowrap; }
  .rp-custom { display: flex; flex-direction: column; gap: 10px; }
  .rp-select {
    display: flex; align-items: center; gap: 8px;
    height: 44px; padding: 0 10px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-md);
    color: var(--text-2);
  }
  .rp-select select { flex: 1; background: none; border: none; outline: none; color: var(--text-1); font-size: 14px; }
  .rp-warn { font-size: 12px; color: var(--warning); }
  .rp-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .rp-actions .btn { height: 40px; }
  .rp-remove {
    display: flex; align-items: center; gap: 8px;
    min-height: 40px; padding: 0 8px; margin: 2px -6px 0;
    border-radius: 10px; color: var(--danger); font-size: 14px; font-weight: 500;
  }
  .rp-remove:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); }
  .rp-remove .material-symbols-rounded { font-size: 19px; }
</style>
