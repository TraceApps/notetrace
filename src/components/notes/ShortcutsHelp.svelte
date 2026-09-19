<script>
  /** ShortcutsHelp: the keyboard shortcut sheet, opened with ? or from Settings. */
  import { fade, scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';
  import { dialogFocus } from '../../lib/dialog-focus.js';
  import { keyboardShortcuts } from '../../stores/settings.js';

  export let open = false;

  const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
  $: groups = [
    { title: $_('shortcuts.group_notes'), rows: [
      [['c'], $_('shortcuts.new_note')],
      [['l'], $_('shortcuts.new_list')],
      [['v'], $_('shortcuts.new_voice')],
      [['/'], $_('shortcuts.search')],
      [[mod, 'K'], $_('shortcuts.search_anywhere')],
      [['j'], $_('shortcuts.next')],
      [['k'], $_('shortcuts.previous')],
      [['Enter'], $_('shortcuts.open')],
    ] },
    { title: $_('shortcuts.group_actions'), rows: [
      [['x'], $_('shortcuts.select')],
      [['f'], $_('shortcuts.pin')],
      [['e'], $_('shortcuts.archive')],
      [['#'], $_('shortcuts.trash')],
      [[mod, 'A'], $_('shortcuts.select_all')],
      [['Esc'], $_('shortcuts.clear')],
    ] },
    { title: $_('shortcuts.group_go'), rows: [
      [['g', 'n'], $_('shortcuts.go_notes')],
      [['g', 'r'], $_('shortcuts.go_reminders')],
      [['g', 'a'], $_('shortcuts.go_archive')],
      [['g', 't'], $_('shortcuts.go_trash')],
      [['g', 's'], $_('shortcuts.go_settings')],
    ] },
    { title: $_('shortcuts.group_tasks'), rows: [
      [['n'], $_('shortcuts.task_add')],
      [['j'], $_('shortcuts.task_next')],
      [['k'], $_('shortcuts.task_previous')],
      [['x'], $_('shortcuts.task_done')],
      [['e'], $_('shortcuts.task_edit')],
      [['d'], $_('shortcuts.task_due')],
      [['m'], $_('shortcuts.task_move')],
      [['o'], $_('shortcuts.task_open')],
      [['#'], $_('shortcuts.task_delete')],
    ] },
    { title: $_('shortcuts.group_editor'), rows: [
      [[mod, 'Enter'], $_('shortcuts.done')],
      [['Esc'], $_('shortcuts.close')],
      [['/'], $_('shortcuts.slash')],
      [['[['], $_('shortcuts.link')],
    ] },
  ];

  function onKey(e) { if (open && e.key === 'Escape') { e.stopPropagation(); open = false; } }
</script>

<svelte:window on:keydown|capture={onKey} />

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="sh-backdrop" on:click={() => open = false} transition:fade={{ duration: 160 }}>
    <div class="sh-panel" role="dialog" aria-modal="true" aria-labelledby="sh-title" tabindex="-1" use:dialogFocus on:click|stopPropagation
      in:scale={{ start: 0.94, duration: 220, easing: cubicOut }} out:scale={{ start: 0.96, duration: 140 }}>
      <header>
        <h2 id="sh-title">{$_('shortcuts.title')}</h2>
        <button class="sh-close" on:click={() => open = false} aria-label={$_('common.close')}>
          <span class="material-symbols-rounded">close</span>
        </button>
      </header>
      {#if !$keyboardShortcuts}<p class="sh-off">{$_('shortcuts.off')}</p>{/if}
      <div class="sh-grid">
        {#each groups as g}
          <section>
            <h3>{g.title}</h3>
            {#each g.rows as [keys, label]}
              <div class="sh-row">
                <span>{label}</span>
                <span class="sh-keys">{#each keys as k, i}{#if i}<span class="sh-plus">{keys[0] === 'g' ? $_('shortcuts.then') : '+'}</span>{/if}<kbd>{k}</kbd>{/each}</span>
              </div>
            {/each}
          </section>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .sh-backdrop {
    position: fixed; inset: 0; z-index: 500;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    display: flex; align-items: center; justify-content: center; padding: 16px;
  }
  .sh-panel {
    width: 760px; max-width: 100%; max-height: calc(100dvh - 32px); overflow: auto;
    background: var(--surface-1); border: 1px solid var(--border-strong);
    border-radius: var(--radius-xl); box-shadow: var(--shadow-lg);
    padding: 20px 24px 24px;
  }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  h2 { font-size: 18px; font-weight: 700; }
  .sh-close { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: var(--text-2); }
  .sh-close:hover { background: var(--surface-2); color: var(--text-1); }
  .sh-off { font-size: 13px; color: var(--warning); margin-bottom: 8px; }
  .sh-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px 32px; }
  h3 { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); margin: 10px 0 6px; }
  .sh-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 14px; color: var(--text-1); border-bottom: 1px solid var(--border); }
  .sh-keys { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .sh-plus { font-size: 11px; color: var(--text-3); }
  kbd {
    min-width: 24px; height: 24px; padding: 0 7px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 6px; border: 1px solid var(--border-strong); border-bottom-width: 2px;
    background: var(--surface-2); color: var(--text-1);
    font: 600 12px/1 var(--font-sans, inherit);
  }
</style>
