<script>
  /**
   * Notes: the notes grid and its sibling views.
   *   /            notes (pinned + others, with capture)
   *   /reminders   notes with a reminder, soonest first
   *   /archive     archived notes
   *   /trash       trashed notes (auto-deleted after 30 days)
   *   /label/:id   notes carrying one label
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import { location, querystring, replace as replaceRoute } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { bannerStyle } from '../stores/settings.js';
  import { NoteApi } from '../lib/api.js';
  import { labels, labelsById, notesChanged, refreshLabels, signalNotesChanged } from '../stores/notes.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { showError, showInfo } from '../stores/toast.js';
  import NoteGrid from '../components/notes/NoteGrid.svelte';
  import NoteEditor from '../components/notes/NoteEditor.svelte';
  import ColorPalette from '../components/notes/ColorPalette.svelte';
  import LabelPicker from '../components/notes/LabelPicker.svelte';
  import Popover from '../components/notes/Popover.svelte';
  import ActionSheet from '../components/ui/ActionSheet.svelte';
  import ReminderPicker from '../components/notes/ReminderPicker.svelte';
  import { nextOccurrence, isPast } from '../lib/reminders.js';
  import { ensureReminderPermission, rescheduleReminders } from '../lib/note-reminders.js';
  import { isOwner, canEdit } from '../lib/note-sharing.js';
  import { pendingShare, shareToNote, takeSharedFiles } from '../lib/share-intent.js';

  export let params = {};

  $: path = ($location || '/').split('?')[0];
  $: view = path.startsWith('/archive') ? 'archive'
    : path.startsWith('/trash') ? 'trash'
    : path.startsWith('/reminders') ? 'reminders'
    : 'notes';
  $: labelId = path.startsWith('/label/') ? Number(params?.id) : null;
  $: activeLabel = labelId != null ? $labelsById.get(labelId) : null;
  $: canCapture = view === 'notes' || view === 'reminders';

  let notes = [];
  let loading = true;
  let query = '';
  let searchTimer;
  let loadSeq = 0;

  let editing = null;        // { note } | { kind } while the editor is open
  let colorTarget = null, colorAnchor = null, colorOpen = false;
  let labelTarget = null, labelAnchor = null, labelOpen = false;
  let reminderTarget = null, reminderAnchor = null, reminderOpen = false;
  let menuNote = null, menuOpen = false;

  $: pinned = view === 'notes' ? notes.filter(n => n.pinned) : [];
  $: byNextReminder = view === 'reminders'
    ? [...notes].sort((a, b) =>
        (nextOccurrence(a.reminder_at, a.reminder_rrule, a.reminder_tz) || 0) - (nextOccurrence(b.reminder_at, b.reminder_rrule, b.reminder_tz) || 0))
    : [];
  $: upcoming = byNextReminder.filter(n => !isPast(n.reminder_at, n.reminder_rrule));
  $: pastReminders = byNextReminder.filter(n => isPast(n.reminder_at, n.reminder_rrule)).reverse();
  $: others = view === 'notes' ? notes.filter(n => !n.pinned) : view === 'reminders' ? upcoming : notes;
  $: heading = activeLabel ? activeLabel.name
    : view === 'reminders' ? $_('routes.reminders.title')
    : view === 'archive' ? $_('routes.archive.title')
    : view === 'trash' ? $_('routes.trash.title')
    : $_('routes.notes.title');

  async function load() {
    const seq = ++loadSeq;
    try {
      const rows = await NoteApi.getNotes({ view, label: labelId, q: query.trim() });
      if (seq === loadSeq) notes = Array.isArray(rows) ? rows : [];
    } catch (e) {
      if (seq === loadSeq) showError(e.message || $_('notes.load_failed'));
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  // Reload whenever the view, label, or a background change says so.
  $: view, labelId, $notesChanged, load();

  function onSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 220);
  }
  function clearSearch() { query = ''; load(); }

  let searchEl;
  const shortcutLabel = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '\u2318K' : 'Ctrl K';
  const focusSearch = () => { searchEl?.focus(); searchEl?.select(); };
  onMount(() => {
    refreshLabels();
    window.addEventListener('note:focus-search', focusSearch);
  });
  onDestroy(() => {
    clearTimeout(searchTimer);
    window.removeEventListener('note:focus-search', focusSearch);
  });

  // ── Editor ─────────────────────────────────────────────────────────
  function openNote(e) { editing = { note: e.detail }; }
  function newNote(kind = 'text') {
    editing = { kind, labels: labelId != null ? [labelId] : [] };
  }

  // Opened from a reminder notification: /?note=<id>
  $: openFromQuery($querystring);
  async function openFromQuery(qs) {
    const params = new URLSearchParams(qs || '');
    if (params.get('share') === '1') {
      const prefill = shareToNote({ title: params.get('title'), text: params.get('text'), url: params.get('url') });
      replaceRoute(path);
      prefill.images = await takeSharedFiles(params.get('files'));
      if (prefill.title || prefill.body_md || prefill.images.length) editing = { kind: 'text', prefill };
      return;
    }
    const id = Number(params.get('note'));
    if (!id || editing) return;
    try {
      const n = await NoteApi.getNote(id);
      if (n) editing = { note: n };
    } catch { /* note gone */ }
    replaceRoute(path);
  }
  async function closeEditor(e) {
    const target = e?.detail?.navigate;
    editing = null;
    load();
    // Following a [[link]] or a Linked From entry opens that note next.
    if (target) {
      await tick();
      try {
        const n = await NoteApi.getNote(target);
        if (n) editing = { note: n };
      } catch { /* note gone */ }
    }
  }

  // Shared from another Android app.
  $: if ($pendingShare && !editing) {
    editing = { kind: 'text', prefill: $pendingShare };
    pendingShare.set(null);
  }

  // ── Quick actions ──────────────────────────────────────────────────
  function replace(n) {
    if (!n) return;
    notes = notes.map(x => x.id === n.id ? n : x);
  }

  async function runAction(note, action, anchor = null) {
    try {
      switch (action) {
        case 'pin':
          replace(await NoteApi.updateNote(note.id, { pinned: !note.pinned }));
          break;
        case 'archive':
          await NoteApi.updateNote(note.id, { archived: true });
          notes = notes.filter(n => n.id !== note.id);
          showInfo($_('notes.toast_archived'));
          break;
        case 'unarchive':
          await NoteApi.updateNote(note.id, { archived: false });
          notes = notes.filter(n => n.id !== note.id);
          showInfo($_('notes.toast_unarchived'));
          break;
        case 'trash':
          await NoteApi.trashNote(note.id);
          notes = notes.filter(n => n.id !== note.id);
          showInfo($_('notes.toast_trashed'));
          break;
        case 'restore':
          await NoteApi.restoreNote(note.id);
          notes = notes.filter(n => n.id !== note.id);
          showInfo($_('notes.toast_restored'));
          break;
        case 'deleteForever': {
          const ok = await confirmDialog({
            title: $_('notes.delete_forever_title'),
            message: $_('notes.delete_forever_message'),
            confirmText: $_('notes.delete_forever'),
            dangerous: true,
          });
          if (!ok) return;
          await NoteApi.deleteNoteForever(note.id);
          notes = notes.filter(n => n.id !== note.id);
          break;
        }
        case 'color':
          colorTarget = note; colorAnchor = anchor; colorOpen = true;
          return;
        case 'labels':
          labelTarget = note; labelAnchor = anchor; labelOpen = true;
          return;
        case 'reminder':
          reminderTarget = note; reminderAnchor = anchor; reminderOpen = true;
          return;
      }
      refreshLabels();
    } catch (e) {
      showError(e.message || $_('notes.save_failed'));
    }
  }

  function onCardAction(e) {
    const { note, action } = e.detail;
    const target = document.activeElement?.getBoundingClientRect?.() || null;
    runAction(note, action, target);
  }

  async function onToggleItem(e) {
    const { note, item } = e.detail;
    // Optimistic: flip it in place so the card responds instantly.
    replace({ ...note, items: note.items.map(i => i.uuid === item.uuid ? { ...i, checked: !i.checked } : i) });
    try {
      replace(await NoteApi.updateItem(note.id, item.uuid, { checked: !item.checked }));
    } catch (err) {
      replace(note);
      showError(err.message || $_('notes.save_failed'));
    }
  }

  async function setColor(c) {
    const note = colorTarget;
    colorOpen = false;
    if (!note) return;
    replace({ ...note, color: c });
    try { replace(await NoteApi.updateNote(note.id, { color: c })); }
    catch (e) { replace(note); showError(e.message); }
  }

  async function setLabels(ids) {
    const note = labelTarget;
    if (!note) return;
    labelTarget = { ...note, labels: ids };
    try {
      const n = await NoteApi.updateNote(note.id, { labels: ids });
      labelTarget = n;
      if (labelId != null && !ids.includes(labelId)) notes = notes.filter(x => x.id !== note.id);
      else replace(n);
      refreshLabels();
    } catch (e) { showError(e.message); }
  }

  async function setReminder(detail) {
    const note = reminderTarget;
    reminderOpen = false;
    if (!note) return;
    await ensureReminderPermission();
    try {
      replace(await NoteApi.updateNote(note.id, detail));
      rescheduleReminders();
      if (view === 'reminders') load();
    } catch (e) { showError(e.message); }
  }
  async function clearReminder() {
    const note = reminderTarget;
    reminderOpen = false;
    if (!note) return;
    try {
      const n = await NoteApi.updateNote(note.id, { reminder_at: null });
      if (view === 'reminders') notes = notes.filter(x => x.id !== note.id); else replace(n);
      rescheduleReminders();
    } catch (e) { showError(e.message); }
  }

  function onMenu(e) {
    menuNote = e.detail.note;
    menuOpen = true;
  }
  $: menuActions = !menuNote ? [] : view === 'trash'
    ? [
        { value: 'restore', label: $_('notes.restore'), icon: 'restore_from_trash' },
        { value: 'deleteForever', label: $_('notes.delete_forever'), icon: 'delete_forever', danger: true },
      ]
    : [
        ...(view === 'notes' ? [{ value: 'pin', label: menuNote.pinned ? $_('notes.unpin') : $_('notes.pin'), icon: 'keep' }] : []),
        ...(isOwner(menuNote) ? [{ value: 'reminder', label: $_('reminders.remind_me'), icon: 'notification_add' }] : []),
        ...(canEdit(menuNote) ? [{ value: 'color', label: $_('notes.color'), icon: 'palette' }] : []),
        { value: 'labels', label: $_('notes.labels'), icon: 'label' },
        view === 'archive'
          ? { value: 'unarchive', label: $_('notes.unarchive'), icon: 'unarchive' }
          : { value: 'archive', label: $_('notes.archive'), icon: 'archive' },
        ...(isOwner(menuNote) ? [{ value: 'trash', label: $_('notes.move_to_trash'), icon: 'delete', danger: true }] : []),
      ];

  function onMenuSelect(e) {
    const note = menuNote;
    menuNote = null;
    runAction(note, e.detail.value, null);
  }

  async function emptyTrash() {
    const ok = await confirmDialog({
      title: $_('notes.empty_trash_title'),
      message: $_('notes.empty_trash_message'),
      confirmText: $_('notes.empty_trash'),
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NoteApi.emptyTrash();
      notes = [];
      signalNotesChanged();
    } catch (e) { showError(e.message); }
  }
</script>

<div class="page-shell notes-page">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{heading}</h1>
  </header>

  <div class="notes-toolbar">
    <div class="search">
      <span class="material-symbols-rounded">search</span>
      <input type="search" bind:this={searchEl} placeholder={$_('notes.search_placeholder')} bind:value={query} on:input={onSearch}
        aria-label={$_('notes.search_placeholder')} />
      {#if !query}
        <kbd class="search-kbd" aria-hidden="true">{shortcutLabel}</kbd>
      {/if}
      {#if query}
        <button class="search-clear" on:click={clearSearch} aria-label={$_('notes.clear_search')}>
          <span class="material-symbols-rounded">close</span>
        </button>
      {/if}
    </div>
    {#if view === 'trash' && notes.length}
      <button class="btn btn-secondary empty-trash" on:click={emptyTrash}>
        <span class="material-symbols-rounded">delete_sweep</span>{$_('notes.empty_trash')}
      </button>
    {/if}
  </div>

  <div class="notes-body">
    {#if canCapture}
      <div class="capture" role="group" aria-label={$_('notes.take_a_note')}>
        <button class="capture-main" on:click={() => newNote('text')}>{$_('notes.take_a_note')}</button>
        <button class="capture-icon" on:click={() => newNote('checklist')} title={$_('notes.new_checklist')} aria-label={$_('notes.new_checklist')}>
          <span class="material-symbols-rounded">check_box</span>
        </button>
      </div>
    {/if}

    {#if view === 'trash'}
      <p class="trash-note">{$_('notes.trash_retention')}</p>
    {/if}

    {#if loading}
      <div class="skeleton-grid" aria-hidden="true">
        {#each Array(6) as _s, i}<div class="skeleton" style="height:{120 + (i % 3) * 50}px"></div>{/each}
      </div>
    {:else if !notes.length}
      <div class="empty">
        <span class="material-symbols-rounded empty-icon">
          {query ? 'search_off' : view === 'reminders' ? 'notifications' : view === 'archive' ? 'archive' : view === 'trash' ? 'delete' : activeLabel ? 'label' : 'sticky_note_2'}
        </span>
        <h2>
          {query ? $_('notes.empty_search_title')
            : view === 'reminders' ? $_('routes.reminders.empty_title')
            : view === 'archive' ? $_('routes.archive.empty_title')
            : view === 'trash' ? $_('routes.trash.empty_title')
            : activeLabel ? $_('routes.label.empty_title')
            : $_('routes.notes.empty_title')}
        </h2>
        <p>
          {query ? $_('notes.empty_search_body')
            : view === 'reminders' ? $_('routes.reminders.empty_body')
            : view === 'archive' ? $_('routes.archive.empty_body')
            : view === 'trash' ? $_('routes.trash.empty_body')
            : activeLabel ? $_('routes.label.empty_body')
            : $_('routes.notes.empty_body')}
        </p>
      </div>
    {:else}
      {#if pinned.length}
        <section class="notes-section">
          <h2 class="section-label"><span class="material-symbols-rounded fill">keep</span>{$_('notes.pinned')}</h2>
          <NoteGrid notes={pinned} {view} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} />
        </section>
      {/if}
      {#if others.length}
        <section class="notes-section">
          {#if pinned.length}<h2 class="section-label">{$_('notes.others')}</h2>{/if}
          {#if view === 'reminders' && pastReminders.length}<h2 class="section-label">{$_('reminders.upcoming')}</h2>{/if}
          <NoteGrid notes={others} {view} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} />
        </section>
      {/if}
      {#if view === 'reminders' && pastReminders.length}
        <section class="notes-section">
          <h2 class="section-label">{$_('reminders.past')}</h2>
          <NoteGrid notes={pastReminders} {view} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} />
        </section>
      {/if}
    {/if}
  </div>

  {#if canCapture}
    <button class="fab" on:click={() => newNote('text')} aria-label={$_('notes.new_note')}>
      <span class="material-symbols-rounded">add</span>
    </button>
  {/if}
</div>

{#if editing}
  <!-- Keyed per open: reopening while the last editor is still fading out
       would otherwise resume that editor with the previous note's state. -->
  {#key editing}
    <NoteEditor note={editing.note || null} initialKind={editing.kind || 'text'} initialLabels={editing.labels || []}
      prefill={editing.prefill || null} on:close={closeEditor} />
  {/key}
{/if}

<Popover bind:open={colorOpen} anchor={colorAnchor}>
  <ColorPalette value={colorTarget?.color} on:select={(e) => setColor(e.detail)} />
</Popover>
<Popover bind:open={reminderOpen} anchor={reminderAnchor}>
  <ReminderPicker reminderAt={reminderTarget?.reminder_at} repeat={reminderTarget?.reminder_rrule} tz={reminderTarget?.reminder_tz}
    on:set={(e) => setReminder(e.detail)} on:clear={clearReminder} />
</Popover>
<Popover bind:open={labelOpen} anchor={labelAnchor}>
  <LabelPicker selected={labelTarget?.labels || []} on:change={(e) => setLabels(e.detail)} />
</Popover>
<ActionSheet bind:open={menuOpen} title={menuNote?.title || ''} actions={menuActions} on:select={onMenuSelect} />

<style>
  .notes-page { --notes-max: 1680px; }
  .notes-toolbar {
    display: flex; align-items: center; gap: 12px;
    padding: 12px var(--page-px) 0;
    max-width: var(--notes-max); margin: 0 auto; width: 100%;
  }
  .search {
    flex: 1; max-width: 560px;
    height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 8px 0 14px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-md);
    color: var(--text-3);
  }
  .search:focus-within { border-color: var(--accent); background: var(--surface-1); }
  .search input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--text-1); font-size: 15px; }
  .search input::-webkit-search-cancel-button { display: none; }
  .search-clear { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
  .search-clear:hover { color: var(--text-1); background: color-mix(in srgb, var(--text-1) 8%, transparent); }
  .empty-trash { height: 44px; }

  .notes-body {
    display: flex; flex-direction: column; gap: 24px;
    padding: 20px var(--page-px) calc(var(--nav-h) + var(--safe-bottom) + 96px);
    max-width: var(--notes-max); margin: 0 auto; width: 100%;
  }

  .capture {
    align-self: center;
    width: 100%; max-width: 600px;
    display: flex; align-items: center; gap: 4px;
    height: 52px; padding: 0 6px 0 4px;
    background: var(--surface-1);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }
  .capture-main {
    flex: 1; height: 100%; padding: 0 14px;
    text-align: left; font-size: 15px; color: var(--text-3);
  }
  .capture-icon { width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center; color: var(--text-2); }
  .capture-icon:hover { background: color-mix(in srgb, var(--text-1) 8%, transparent); color: var(--text-1); }

  .trash-note { text-align: center; font-size: 13px; color: var(--text-3); }

  .notes-section { display: flex; flex-direction: column; gap: 12px; }
  .section-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--text-3); padding-left: 2px;
  }
  .section-label .material-symbols-rounded { font-size: 14px; }
  .fill { font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24; }

  .skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(236px, 1fr)); gap: 16px; align-items: start; }
  @media (max-width: 600px) { .skeleton-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } }
  .skeleton { border-radius: var(--radius-lg); background: var(--surface-1); border: 1px solid var(--border); animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.55; } }
  @media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }

  .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; margin: 10vh auto 0; max-width: 360px; }
  .empty-icon { font-size: 48px; color: var(--accent); margin-bottom: 8px; }
  .empty h2 { font-family: var(--font-note-title); font-weight: 500; font-size: 24px; }
  .empty p { color: var(--text-2); font-size: 15px; line-height: 1.5; }

  /* Phones get a thumb-reachable button instead of the capture bar. */
  .fab {
    position: fixed;
    right: 16px;
    bottom: calc(var(--nav-h) + var(--safe-bottom) + 16px);
    width: 60px; height: 60px;
    border-radius: 20px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: var(--accent-text);
    box-shadow: var(--shadow-lg);
    display: none; align-items: center; justify-content: center;
    z-index: 30;
  }
  .fab .material-symbols-rounded { font-size: 30px; }
  @media (max-width: 600px) {
    .capture { display: none; }
    .fab { display: flex; }
    .notes-body { gap: 18px; padding-top: 16px; }
  }
  .search-kbd {
    display: none;
    padding: 2px 7px; border-radius: 6px;
    border: 1px solid var(--border); color: var(--text-3);
    font: 500 11px/1.4 var(--font-sans, inherit);
    white-space: nowrap;
  }
  @media (hover: hover) and (min-width: 768px) {
    .search-kbd { display: inline-block; }
  }
</style>
