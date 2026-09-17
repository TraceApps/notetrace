<script>
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { location, push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { createEventDispatcher, onMount, onDestroy, tick } from 'svelte';
  import { resolveAssetUrl, iconUrl, isNative, getNativeMode } from '../../lib/platform.js';
  import { currentUser, userMgmtActive, logout } from '../../stores/auth.js';
  import { APP_VERSION } from '../../lib/version.js';
  import { updateAvailable } from '../../lib/updates.js';
  import { pwaUpdateReady } from '../../lib/pwa-update.js';
  import { labels, refreshLabels, notesChanged, countsChanged } from '../../stores/notes.js';
  import { sidebarRail, sidebarLabelsCollapsed } from '../../stores/settings.js';
  import { sharingAvailable } from '../../lib/note-sharing.js';
  import { NoteApi } from '../../lib/api.js';
  import { nextOccurrence } from '../../lib/reminders.js';
  import { syncState } from '../../lib/sync.js';
  import { offlineState } from '../../lib/offline-api.js';
  import { cooktraceLink, cooktraceOn, loadCooktraceLink, shopping, primeShopping } from '../../lib/cooktrace.js';
  import { groupShopping } from '../../lib/shopping-groups.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { relativeTime } from '../../lib/relative-time.js';
  import { todayStr } from '../../lib/due-dates.js';
  import LabelManager from '../notes/LabelManager.svelte';
  import LabelTreeItem from './LabelTreeItem.svelte';
  import LabelGlyph from '../notes/LabelGlyph.svelte';
  import { buildLabelTree } from '../../lib/label-tree.js';
  import { labelTreeCollapsed } from '../../stores/settings.js';

  export let open = false;
  export let persistent = false;
  const dispatch = createEventDispatcher();

  // The icon rail only applies to the pinned desktop sidebar; the phone
  // drawer always opens full width.
  /** Which setting holds icons-only: Auto navigation keeps a separate one for medium screens. */
  export let railStore = sidebarRail;
  $: rail = persistent && $railStore;

  // Collapsed, each icon names itself in a label beside the rail on hover or focus.
  let tip = null;   // { text, top, left }
  function showTip(e) {
    const el = rail && e.target.closest?.('[data-tip]');
    if (!el) { tip = null; return; }
    const r = el.getBoundingClientRect();
    tip = { text: el.dataset.tip, top: Math.round(r.top + r.height / 2), left: Math.round(r.right + 12) };
  }
  const hideTip = () => { tip = null; };
  $: if (!rail) tip = null;

  async function handleLogout() {
    // Edits made offline in this browser go with the sign-out: try sending them first, then ask.
    if (!isNative) {
      const { flushOutbox, pendingCount } = await import('../../lib/offline-api.js');
      await flushOutbox().catch(() => {});
      const n = await pendingCount();
      if (n && !await confirmDialog({
        title: $_('offline.logout_title'),
        message: $_('offline.logout_message', { values: { n } }),
        confirmText: $_('offline.logout_confirm'),
        cancelText: $_('common.cancel'),
        dangerous: true,
      })) return;
    }
    await logout();
    open = false;
    dispatch('close');
    if (isNative) {
      // Fade out then reload for smooth transition
      document.body.style.transition = 'opacity 0.3s';
      document.body.style.opacity = '0';
      setTimeout(() => window.location.reload(), 350);
    }
  }

  function getInitial(user) {
    return (user?.full_name || user?.username || '?')[0].toUpperCase();
  }

  $: navItems = [
    { path: '/notes',     icon: 'sticky_note_2', label: $_('nav.notes') },
    { path: '/reminders', icon: 'notifications', label: $_('nav.reminders'), badge: dueToday },
    { path: '/tasks',     icon: 'task_alt',      label: $_('nav.tasks'),     badge: tasksDue, badgeKey: 'sidebar.tasks_due' },
    ...($sharingAvailable ? [{ path: '/shared', icon: 'group', label: $_('nav.shared') }] : []),
    { path: '/archive',   icon: 'archive',       label: $_('nav.archive') },
    { path: '/trash',     icon: 'delete',        label: $_('nav.trash') },
  ];
  $: settingsItem = { path: '/settings', icon: 'settings', label: $_('nav.settings') };

  // The CookTrace shopping list sits with the labels, once CookTrace is on.
  $: showShopping = cooktraceOn($cooktraceLink);
  $: if (showShopping) primeShopping();
  $: shoppingOpen = groupShopping($shopping.items || []).groups.reduce((n, g) => n + g.items.length, 0);

  let labelManagerOpen = false;
  $: labelTree = buildLabelTree($labels);
  function toggleBranch(path) {
    const cur = $labelTreeCollapsed || [];
    labelTreeCollapsed.set(cur.includes(path) ? cur.filter(p => p !== path) : [...cur, path]);
  }

  // ── Reminders due today (the badge on Reminders) ──────────────────
  let dueToday = 0;
  let tasksDue = 0;   // open checklist items due today or overdue
  let _dueTimer;
  async function countDueToday() {
    try {
      const list = await NoteApi.getNotes({ view: 'reminders' });
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      dueToday = (list || []).filter(n => {
        const next = nextOccurrence(n.reminder_at, n.reminder_rrule, n.reminder_tz, now);
        return next && next >= now && next < end;
      }).length;
      // Counted on the server: a badge shouldn't cost the whole library.
      const counts = await NoteApi.getNoteCounts(todayStr(now));
      tasksDue = counts?.tasksDue || 0;
    } catch { /* keep the last count */ }
  }
  $: $notesChanged, $countsChanged, countDueToday();

  onMount(() => {
    loadCooktraceLink();
    refreshLabels();
    _dueTimer = setInterval(countDueToday, 5 * 60 * 1000);
  });
  onDestroy(() => clearInterval(_dueTimer));

  function go(path) {
    push(path);
    if (!persistent) {
      open = false;
      dispatch('close');
    }
  }

  function close() {
    if (!persistent) {
      open = false;
      dispatch('close');
    }
  }

  // '/' renders the Notes list, so it highlights Notes.
  $: activePath = ($location.split('?')[0] === '/') ? '/notes' : $location.split('?')[0];
  function isTabActive(itemPath, activePath) {
    if (itemPath === activePath) return true;
    if (itemPath === '/') return false;
    return activePath.startsWith(itemPath + '/');
  }

  // ── Sliding highlight ─────────────────────────────────────────────
  // One pill glides to the active item instead of each item lighting up.
  let navEl;
  let pill = { top: 0, height: 0, visible: false };
  let pillReady = false;
  async function placePill() {
    await tick();
    const el = navEl?.querySelector('.sidebar-item.active');
    if (!el) { pill = { ...pill, visible: false }; return; }
    pill = { top: el.offsetTop, height: el.offsetHeight, visible: true };
    // Skip the glide on first paint so it doesn't slide in from the top.
    if (!pillReady) requestAnimationFrame(() => { pillReady = true; });
  }
  $: activePath, rail, $labels, $sidebarLabelsCollapsed, $labelTreeCollapsed, navItems, open, placePill();
  let _ro, _observed = null;
  $: observeNav(navEl);
  function observeNav(el) {
    if (el === _observed || typeof ResizeObserver === 'undefined') return;
    _ro?.disconnect();
    _observed = el;
    pillReady = false;
    if (!el) return;
    _ro = new ResizeObserver(() => placePill());
    _ro.observe(el);
  }
  onDestroy(() => _ro?.disconnect());

  // ── Sync status (Android app connected to a server) ───────────────
  $: syncMode = isNative && getNativeMode() === 'server';
  // The web app says so when it's offline or has edits waiting.
  $: webSyncText = isNative ? ''
    : !$offlineState.online ? $_('sidebar.offline')
    : $offlineState.syncing ? $_('sidebar.syncing')
    : $offlineState.pending ? $_('offline.waiting', { values: { n: $offlineState.pending } })
    : '';
  $: syncText = !isNative ? webSyncText : (_tick, !syncMode) ? ''
    : !$syncState.online || $syncState.connectionIssue ? $_('sidebar.offline')
    : $syncState.syncing ? $_('sidebar.syncing')
    : $syncState.lastSync ? $_('sidebar.synced', { values: { when: relativeTime($syncState.lastSync).toLowerCase() } })
    : $_('sidebar.not_synced');
  $: syncBad = isNative ? syncMode && (!$syncState.online || !!$syncState.connectionIssue) : !$offlineState.online;
  // Refresh the "Synced 2 min ago" text now and then.
  let _tick = 0;
  const _tickTimer = setInterval(() => { _tick++; }, 60 * 1000);
  onDestroy(() => clearInterval(_tickTimer));
</script>

{#if open}
  <!-- Backdrop (overlay mode only) -->
  {#if !persistent}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="sidebar-backdrop"
      in:fade={{ duration: 200 }}
      out:fade={{ duration: 160 }}
      on:click={close}
    ></div>
  {/if}

  <!-- Panel -->
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <!-- svelte-ignore a11y_mouse_events_have_key_events (focusin and focusout do the same) -->
  <aside
    class="sidebar-panel"
    class:sidebar-persistent={persistent}
    class:rail
    in:fly={{ x: -280, duration: persistent ? 0 : 280, easing: cubicOut }}
    out:fly={{ x: -280, duration: persistent ? 0 : 200 }}
    aria-label="Navigation menu"
    on:mouseover={showTip} on:focusin={showTip} on:mouseleave={hideTip} on:focusout={hideTip} on:click={hideTip}
  >
    <!-- App branding -->
    <div class="sidebar-brand">
      {#if rail}
        <!-- Collapsed: just the expand button, centered. -->
        <button class="rail-toggle" on:click={() => railStore.set(false)}
          data-tip={$_('sidebar.expand')} aria-label={$_('sidebar.expand')} aria-expanded="false">
          <span class="material-symbols-rounded">menu</span>
        </button>
      {:else}
        <img class="brand-icon" src={iconUrl('/icons/logo.png')} alt="NoteTrace" />
        <div class="brand-text">
          <span class="brand-name">{$_('sidebar_ct.brand')}</span>
          <span class="brand-tagline">Trace Every Thought</span>
        </div>
        {#if persistent}
          <button class="rail-toggle" on:click={() => railStore.set(true)}
            title={$_('sidebar.collapse')} aria-label={$_('sidebar.collapse')} aria-expanded="true">
            <span class="material-symbols-rounded">menu_open</span>
          </button>
        {/if}
      {/if}
    </div>

    <div class="sidebar-divider"></div>

    <!-- Nav items -->
    <nav class="sidebar-nav" bind:this={navEl}>
      <div class="nav-pill" class:visible={pill.visible} class:ready={pillReady}
        style="transform: translateY({pill.top}px); height: {pill.height}px" aria-hidden="true"></div>

      {#each navItems as item (item.path)}
        <button
          class="sidebar-item"
          class:active={isTabActive(item.path, activePath)}
          on:click={() => go(item.path)}
          data-tip={rail ? (item.badge ? `${item.label}: ${$_(item.badgeKey || 'sidebar.due_today', { values: { count: item.badge } })}` : item.label) : undefined}
          aria-label={rail ? item.label : undefined}
        >
          <span class="material-symbols-rounded sidebar-icon">
            {item.icon}
            {#if rail && item.badge}<span class="nav-count-dot" aria-hidden="true"></span>{/if}
          </span>
          {#if !rail}
            <span class="sidebar-label">{item.label}</span>
            {#if item.badge}
              <span class="nav-badge" title={$_(item.badgeKey || 'sidebar.due_today', { values: { count: item.badge } })}>{item.badge > 99 ? '99+' : item.badge}</span>
            {/if}
          {/if}
          {#if isTabActive(item.path, activePath)}
            <div class="active-indicator"></div>
          {/if}
        </button>
      {/each}

      {#if rail}
        <div class="sidebar-divider nav-divider"></div>
        {#if showShopping}
          <button class="sidebar-item rail-label" class:active={activePath === '/shopping'} on:click={() => go('/shopping')}
            data-tip={$_('nav.shopping')} aria-label={$_('nav.shopping')}>
            <span class="material-symbols-rounded sidebar-icon">shopping_cart</span>
          </button>
        {/if}
        {#each $labels as l (l.id)}
          <button class="sidebar-item rail-label" class:active={activePath === `/label/${l.id}`} on:click={() => go(`/label/${l.id}`)}
            data-tip={l.name} aria-label={l.name}>
            <span class="sidebar-icon label-dot-wrap"><LabelGlyph label={l} size={10} iconSize={22} /></span>
          </button>
        {/each}
      {:else}
        <div class="sidebar-group">
          <button class="sidebar-group-toggle" on:click={() => sidebarLabelsCollapsed.set(!$sidebarLabelsCollapsed)}
            aria-expanded={!$sidebarLabelsCollapsed}
            title={$sidebarLabelsCollapsed ? $_('sidebar.show_labels') : $_('sidebar.hide_labels')}>
            <span class="sidebar-group-label">{$_('nav.labels')}</span>
            <span class="material-symbols-rounded group-chevron" class:collapsed={$sidebarLabelsCollapsed}>expand_more</span>
          </button>
          <button class="sidebar-group-action" on:click={() => labelManagerOpen = true}
            title={$_('labels.edit_labels')} aria-label={$_('labels.edit_labels')}>
            <span class="material-symbols-rounded">edit</span>
          </button>
        </div>
        {#if !$sidebarLabelsCollapsed}
          {#if showShopping}
            <button class="sidebar-item sidebar-label-item tree-item shopping-label" class:active={activePath === '/shopping'}
              style="--depth:0" on:click={() => go('/shopping')}>
              <span class="label-dot-wrap"><span class="material-symbols-rounded shopping-glyph">shopping_cart</span></span>
              <span class="sidebar-label">{$_('nav.shopping')}</span>
              {#if shoppingOpen}<span class="label-count">{shoppingOpen}</span>{/if}
              {#if activePath === '/shopping'}<div class="active-indicator"></div>{/if}
            </button>
          {/if}
          {#each labelTree as node (node.path)}
            <LabelTreeItem {node} {activePath} collapsed={$labelTreeCollapsed || []}
              on:go={(e) => go(e.detail)} on:toggle={(e) => toggleBranch(e.detail)} />
          {/each}
          {#if !$labels.length && !showShopping}
            <button class="sidebar-item sidebar-label-item muted" on:click={() => labelManagerOpen = true}>
              <span class="material-symbols-rounded sidebar-icon">new_label</span>
              <span class="sidebar-label">{$_('labels.create')}</span>
            </button>
          {/if}
        {/if}
      {/if}

      <div class="sidebar-divider nav-divider"></div>
      <button class="sidebar-item" class:active={isTabActive(settingsItem.path, activePath)} on:click={() => go(settingsItem.path)}
        data-tip={rail ? settingsItem.label : undefined} aria-label={rail ? settingsItem.label : undefined}>
        <span class="material-symbols-rounded sidebar-icon">
          {settingsItem.icon}
          {#if $updateAvailable.available || $pwaUpdateReady}
            <span class="nav-update-dot" aria-label="Update available"></span>
          {/if}
        </span>
        {#if !rail}<span class="sidebar-label">{settingsItem.label}</span>{/if}
        {#if isTabActive(settingsItem.path, activePath)}<div class="active-indicator"></div>{/if}
      </button>
    </nav>

    <div class="sidebar-footer">
      {#if $userMgmtActive && $currentUser}
        <div class="sidebar-user">
          <button class="user-avatar" on:click={() => go('/profile')}
            data-tip={rail ? `${$currentUser.full_name || $currentUser.username} · ${APP_VERSION}` : undefined}
            aria-label={$currentUser.full_name || $currentUser.username}>
            {#if $currentUser.avatar_url}
              <img src={resolveAssetUrl($currentUser.avatar_url)} alt="" class="user-avatar-img" />
            {:else}
              {getInitial($currentUser)}
            {/if}
            {#if rail && syncBad}<span class="avatar-sync-dot" aria-hidden="true"></span>{/if}
          </button>
          {#if !rail}
            <div class="user-info">
              <span class="user-name">{$currentUser.full_name || $currentUser.username}</span>
              <span class="sidebar-version">
                {APP_VERSION}{#if syncText}<span class="sync-sep"> · </span><span class="sync-text" class:bad={syncBad}>{syncText}</span>{/if}
              </span>
            </div>
            <button class="btn-icon logout-btn" on:click={handleLogout} title={$_('common.sign_out')} aria-label={$_('common.sign_out')}>
              <span class="material-symbols-rounded">logout</span>
            </button>
          {/if}
        </div>
      {:else}
        <span class="sidebar-version" data-tip={rail ? APP_VERSION : undefined}>
          {rail ? APP_VERSION.replace(/-.*/, '') : APP_VERSION}{#if syncText && !rail}<span class="sync-sep"> · </span><span class="sync-text" class:bad={syncBad}>{syncText}</span>{/if}
        </span>
      {/if}
    </div>
  </aside>
{/if}

{#if tip}
  <div class="rail-tip" role="tooltip" style="top: {tip.top}px; left: {tip.left}px">{tip.text}</div>
{/if}

<LabelManager bind:open={labelManagerOpen} />

<style>
  .sidebar-backdrop {
    position: fixed; inset: 0;
    /* Dark frosted glass scrim covering everything to the right of the
       sidebar panel, with a heavy blur and saturation boost so the page
       content reads as background texture. */
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    z-index: 100;
  }

  .sidebar-panel {
    position: fixed;
    top: 0; left: 0; bottom: 0;
    width: 280px;
    background: var(--surface-1);
    border-right: 1px solid var(--border);
    z-index: 101;
    display: flex;
    flex-direction: column;
    padding: var(--safe-top) 0 var(--safe-bottom);
    box-shadow: var(--shadow-lg);
    transition: width 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  /* Persistent sidebar: no shadow, lower z-index (no need to float above content) */
  .sidebar-persistent {
    box-shadow: none;
    z-index: 40;
  }
  .sidebar-panel.rail { width: 76px; }

  .sidebar-brand {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 12px 16px 20px;
    position: relative;
  }
  .rail .sidebar-brand { justify-content: center; padding: 20px 0 16px; min-height: 80px; }
  .sidebar-panel { overflow: hidden; white-space: nowrap; }
  .brand-icon {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    flex-shrink: 0;
    filter: drop-shadow(0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent));
  }
  .rail .brand-icon { width: 38px; height: 38px; }
  .brand-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .brand-name {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .brand-tagline { font-size: 12px; color: var(--text-3); }
  .rail-toggle {
    width: 32px; height: 32px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 9px; color: var(--text-3);
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .rail-toggle:hover { background: var(--surface-2); color: var(--text-1); }
  .rail-toggle .material-symbols-rounded { font-size: 20px; }
  .rail .rail-toggle { width: 44px; height: 44px; border-radius: var(--radius-md); }
  .rail .rail-toggle .material-symbols-rounded { font-size: 24px; }

  .rail-tip {
    position: fixed; z-index: 500; transform: translateY(-50%);
    padding: 6px 10px; border-radius: 8px;
    background: var(--surface-3, var(--surface-2)); color: var(--text-1);
    border: 1px solid var(--border); box-shadow: var(--shadow-md, 0 6px 20px rgba(0,0,0,.35));
    font-size: 13px; font-weight: 500; white-space: nowrap; pointer-events: none;
    animation: rail-tip-in 120ms ease-out;
  }
  @keyframes rail-tip-in { from { opacity: 0; transform: translate(-4px, -50%); } }
  :global(html.no-animations) .rail-tip { animation: none; }

  .sidebar-divider { height: 1px; background: var(--border); margin: 0 16px 8px; }
  .rail .sidebar-divider { margin: 0 14px 8px; }

  .sidebar-nav {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 10px;
    overflow-y: auto;
    overflow-x: hidden;
    position: relative;
  }
  .rail .sidebar-nav { padding: 0 12px; scrollbar-width: none; }
  .rail .sidebar-nav::-webkit-scrollbar { display: none; }

  /* The sliding highlight behind the active item. */
  .nav-pill {
    position: absolute; left: 10px; right: 10px; top: 0;
    border-radius: var(--radius-md);
    background: var(--accent-dim);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent);
    opacity: 0;
    pointer-events: none;
  }
  .rail .nav-pill { left: 12px; right: 12px; }
  .nav-pill.visible { opacity: 1; }
  .nav-pill.ready {
    transition: transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1), height 280ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 160ms ease;
  }
  :global(html.no-animations) .nav-pill.ready { transition: none; }
 @media (prefers-reduced-motion: reduce) { .nav-pill.ready { transition: opacity 120ms ease; } }

  .sidebar-group {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 4px 4px 8px;
  }
  .sidebar-group-toggle {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 6px; margin-left: -2px; border-radius: 7px;
  }
  .sidebar-group-toggle:hover { background: var(--surface-2); }
  .sidebar-group-toggle:hover .sidebar-group-label { color: var(--text-2); }
  .sidebar-group-label { font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); transition: color var(--dur-fast); }
  .group-chevron { font-size: 16px; color: var(--text-3); transition: transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1); }
  .group-chevron.collapsed { transform: rotate(-90deg); }
  .sidebar-group-action { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
  .sidebar-group-action:hover { background: var(--surface-2); color: var(--text-1); }
  .sidebar-group-action .material-symbols-rounded { font-size: 16px; }
  .sidebar-panel :global(.sidebar-label-item) { padding-top: 9px !important; padding-bottom: 9px !important; font-size: 14px !important; }
  .sidebar-panel :global(.sidebar-label-item.muted) { color: var(--text-3); }
  .sidebar-panel :global(.label-dot-wrap) { width: 22px; display: flex; justify-content: center; align-items: center; flex-shrink: 0; }
  .sidebar-panel :global(.label-dot) { width: 8px; height: 8px; border-radius: 50%; }
  .rail-label :global(.label-dot) { width: 10px; height: 10px; }
  .shopping-glyph { font-size: 18px; color: var(--accent); }
  .rail-label .shopping-glyph { font-size: 22px; }
  .sidebar-panel :global(.label-count) { font-size: 12px; color: var(--text-3); }
  /* Nested labels (LabelTreeItem) */
  .sidebar-nav :global(.tree-item) { padding-left: calc(14px + var(--depth, 0) * 18px) !important; }
  .sidebar-nav :global(.tree-item.group) { color: var(--text-3); }
  .sidebar-nav :global(.tree-chevron) { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 6px; margin: -2px 0; }
  .sidebar-nav :global(.tree-chevron:hover) { background: color-mix(in srgb, var(--text-1) 10%, transparent); }
  .sidebar-nav :global(.tree-chevron .material-symbols-rounded) { font-size: 18px; transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
  .sidebar-nav :global(.tree-chevron .folded) { transform: rotate(-90deg); }
  .nav-divider { margin: 10px 6px; }
  .sidebar-panel :global(.sidebar-item) {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 13px 14px;
    border-radius: var(--radius-md);
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-2);
    font-size: 15px;
    font-weight: 500;
    text-align: left;
    width: 100%;
    position: relative;
    z-index: 1;
    transition: background var(--dur-fast), color var(--dur-fast), transform 120ms ease;
    -webkit-tap-highlight-color: transparent;
  }
  .rail :global(.sidebar-item) { justify-content: center; padding: 12px 0; gap: 0; }
  .rail :global(.sidebar-label-item), .rail .rail-label { padding: 10px 0 !important; }
  .sidebar-panel :global(.sidebar-item:hover) { background: color-mix(in srgb, var(--text-1) 6%, transparent); color: var(--text-1); }
  .sidebar-panel :global(.sidebar-item.active) { color: var(--accent); }
  /* On a light pill the accent itself is too faint to read (4:1); a deeper shade of it passes. */
  :global([data-theme="light"]) .sidebar-panel :global(.sidebar-item.active) { color: color-mix(in srgb, var(--accent) 78%, #000); }
  .sidebar-panel :global(.sidebar-item.active:hover) { background: none; }
  .sidebar-panel :global(.sidebar-item:active) { transform: scale(0.98); }
  .sidebar-panel :global(.sidebar-item:focus-visible),
  .rail-toggle:focus-visible,
  .sidebar-group-toggle:focus-visible,
  .sidebar-group-action:focus-visible,
  .user-avatar:focus-visible,
  .logout-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .sidebar-panel :global(.sidebar-icon) { font-size: 22px; flex-shrink: 0; position: relative; }
  /* Update-available dot on the Settings nav icon. Same accent tint the
     banner uses so the two surfaces read as one signal. */
  .nav-update-dot, .nav-count-dot {
    position: absolute;
    top: 0;
    right: -2px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--surface-1);
  }
  .sidebar-panel :global(.sidebar-label) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nav-badge {
    min-width: 20px; height: 20px; padding: 0 6px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: var(--radius-full);
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: var(--accent-text);
    font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
  }

  .sidebar-panel :global(.active-indicator) {
    width: 4px;
    height: 20px;
    border-radius: var(--radius-full);
    background: var(--accent);
    position: absolute;
    right: -10px;
    top: 50%;
    transform: translateY(-50%);
  }
  .rail :global(.active-indicator) { right: -12px; }

  .sidebar-footer {
    padding: 12px 14px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }
  .rail .sidebar-footer { justify-content: center; padding: 12px 0; }
  .sidebar-version { font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sync-sep { opacity: 0.6; }
  .sync-text.bad { color: var(--warning); }

  .sidebar-user {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
  }
  .rail .sidebar-user { justify-content: center; }
  .user-avatar {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--accent-dim);
    color: var(--accent);
    font-size: 14px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    overflow: visible;
    position: relative;
    cursor: pointer;
  }
  .user-avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 50%;
  }
  .avatar-sync-dot {
    position: absolute; right: -1px; bottom: -1px;
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--warning); box-shadow: 0 0 0 2px var(--surface-1);
  }
  .user-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .user-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .logout-btn {
    flex-shrink: 0;
    color: var(--text-3);
    transition: color var(--dur-fast);
  }
  .logout-btn:hover { color: var(--error, #f87171); }
</style>
