<script>
  import { location, push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { updateAvailable } from '../../lib/updates.js';
  import { pwaUpdateReady } from '../../lib/pwa-update.js';
  import { navStyle } from '../../stores/settings.js';
  import { tick } from 'svelte';

  // Labels resolve at render time via $_() so tab text follows the
  // active locale without needing to re-mount when Language changes.
  $: tabs = [
    { path: '/notes',    icon: 'sticky_note_2', label: $_('nav.notes')    },
    { path: '/reminders', icon: 'notifications', label: $_('nav.reminders') },
    { path: '/tasks',    icon: 'task_alt',      label: $_('nav.tasks')    },
    { path: '/archive',  icon: 'archive',       label: $_('nav.archive')  },
    { path: '/trash',    icon: 'delete',        label: $_('nav.trash')    },
    { path: '/settings', icon: 'settings',      label: $_('nav.settings') },
  ];
  $: activeIdx = (() => {
    const base = $location.split('?')[0];
    // Treat '/' as Notes
    const norm = base === '/' ? '/notes' : base;
    // Prefix-match so nested paths light up their parent tab. Walk
    // longest-prefix-first so a short path never shadows a longer one.
    const sorted = tabs
      .map((t, i) => ({ t, i }))
      .sort((a, b) => b.t.path.length - a.t.path.length);
    for (const { t, i } of sorted) {
      if (t.path.startsWith('#')) continue;
      if (norm === t.path || norm.startsWith(t.path + '/')) return i;
    }
    return -1;
  })();

  async function go(path) {
    if (path !== '#search') { push(path); return; }
    const base = $location.split('?')[0];
    const onNotes = base === '/' || /^\/(notes|reminders|archive|trash|shared|label\/)/.test(base);
    if (!onNotes) {
      await push('/');
      await tick();
      await new Promise(r => setTimeout(r, 80));
    }
    window.dispatchEvent(new CustomEvent('note:focus-search'));
  }
</script>

<nav class="bottom-nav" aria-label="Main navigation">
  <div
    class:hidden-pill={activeIdx < 0}
    class="nav-pill"
    style="left: calc({(activeIdx / tabs.length * 100).toFixed(2)}%); width: calc(100% / {tabs.length})"
  ></div>

  {#each tabs as tab, i}
    <button
      class="nav-tab"
      class:active={i === activeIdx}
      on:click={() => go(tab.path)}
      aria-label={tab.label}
      aria-current={i === activeIdx ? 'page' : undefined}
    >
      <span class="material-symbols-rounded nav-icon">
        {tab.icon}
        {#if tab.path === '/settings' && ($updateAvailable.available || $pwaUpdateReady)}
          <span class="nav-update-dot" aria-label="Update available"></span>
        {/if}
      </span>
      <span class="nav-label">{tab.label}</span>
    </button>
  {/each}
</nav>

<style>
  .hidden-pill { opacity: 0; }
  .bottom-nav {
    position: fixed;
    bottom: 0;
    /* Beside a pinned sidebar, not under it. */
    left: var(--sidebar-w, 0px);
    right: 0;
    height: calc(var(--nav-h) + var(--safe-bottom));
    padding-bottom: var(--safe-bottom);
    background: var(--glass-surface);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: stretch;
    z-index: 50;
  }

  .nav-pill {
    position: absolute;
    top: 6px;
    left: 0;
    height: calc(100% - 12px - var(--safe-bottom));
    background: linear-gradient(135deg, var(--accent-dim), color-mix(in srgb, var(--accent) 22%, transparent));
    border-radius: var(--radius-md);
    box-shadow: 0 0 16px var(--accent-dim);
    transition: left var(--dur-base) var(--ease-inout);
    pointer-events: none;
  }

  .nav-tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 8px 0 4px;
    position: relative;
    transition: color var(--dur-fast) var(--ease-out);
    color: var(--text-3);
    -webkit-tap-highlight-color: transparent;
  }
  .nav-tab.active  { color: var(--accent); }
  .nav-tab:active  { transform: scale(0.92); }

  .nav-icon {
    font-size: 22px;
    transition: transform var(--dur-fast) var(--ease-spring);
    position: relative;
  }
  /* Update-available dot, same accent tint as the sidebar/banner. */
  .nav-update-dot {
    position: absolute;
    top: -1px;
    right: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--surface-1);
  }
  .nav-tab.active .nav-icon { transform: scale(1.1); }

  .nav-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  /* A narrow cover screen: six labels need a little less spacing to stay apart. */
  @media (max-width: 379px) {
    .nav-label { font-size: 9px; letter-spacing: 0.01em; }
  }
</style>
