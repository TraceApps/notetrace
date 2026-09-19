<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { timeFormat } from '../../stores/settings.js';
  import { nextOccurrence, formatReminder, isPast } from '../../lib/reminders.js';

  export let note;
  export let size = 'sm';
  export let removable = false;
  export let clickable = false;

  const dispatch = createEventDispatcher();

  $: next = nextOccurrence(note.reminder_at, note.reminder_rrule, note.reminder_tz);
  $: past = isPast(note.reminder_at, note.reminder_rrule);
  $: label = formatReminder(next, {
    hour12: $timeFormat === '24h' ? false : undefined,
    today: $_('reminders.today'),
    tomorrow: $_('reminders.tomorrow'),
  });
</script>

{#if next}
  <span class="rchip {size}" class:past title={note.reminder_rrule ? $_(`reminders.repeat_${note.reminder_rrule}`) : ''}>
    {#if clickable}
      <button type="button" class="rchip-main" on:click|stopPropagation={() => dispatch('edit')}
        aria-label={$_('reminders.edit_reminder')}>
        <span class="material-symbols-rounded icon">{note.reminder_rrule ? 'event_repeat' : 'notifications'}</span>
        <span class="text">{label}</span>
      </button>
    {:else}
      <span class="material-symbols-rounded icon">{note.reminder_rrule ? 'event_repeat' : 'notifications'}</span>
      <span class="text">{label}</span>
    {/if}
    {#if removable}
      <button type="button" class="rchip-x" on:click|stopPropagation={() => dispatch('clear')} aria-label={$_('reminders.remove')}>
        <span class="material-symbols-rounded">close</span>
      </button>
    {/if}
  </span>
{/if}

<style>
  .rchip {
    display: inline-flex; align-items: center; gap: 4px;
    border-radius: var(--radius-full);
    background: var(--accent-dim); color: var(--accent);
    font-weight: 600;
    max-width: 100%;
  }
  .rchip.sm { height: 24px; padding: 0 9px; font-size: 11px; }
  .rchip.md { height: 30px; padding: 0 4px 0 11px; font-size: 13px; }
  .rchip.md:not(:has(.rchip-x)) { padding-right: 11px; }
  .rchip.past { background: color-mix(in srgb, var(--text-1) 7%, transparent); color: var(--text-3); }
  .rchip.past .text { text-decoration: line-through; }
  .icon { font-size: 14px; font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 20; }
  .md .icon { font-size: 16px; }
  .text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rchip-main { display: inline-flex; align-items: center; gap: 4px; color: inherit; font: inherit; min-width: 0; }
  .rchip-x { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: inherit; opacity: 0.7; }
  .rchip-x:hover { opacity: 1; background: color-mix(in srgb, currentColor 14%, transparent); }
  .rchip-x .material-symbols-rounded { font-size: 15px; }
</style>
