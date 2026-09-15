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
  import { slide, fly } from 'svelte/transition';
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
  import { groupByDay } from '../lib/timeline.js';
  import { notesLayout, noteSort, noteOrder, keyboardShortcuts, swipeToArchive } from '../stores/settings.js';
  import { showUndo } from '../stores/toast.js';
  import ShortcutsHelp from '../components/notes/ShortcutsHelp.svelte';
  import { push as pushRoute } from 'svelte-spa-router';
  import { noteKey, applyOrder, mergeOrder } from '../lib/note-order.js';
  import { labelAndDescendantIds } from '../lib/label-tree.js';
  import { isNative } from '../lib/platform.js';
  import NoteCard from '../components/notes/NoteCard.svelte';
  import { pendingShare, shareToNote, takeSharedFiles } from '../lib/share-intent.js';
  import { FILTER_TYPES, emptyFilters, hasFilters, matchesFilters, toggleFilter } from '../lib/note-filters.js';
  import { NOTE_COLORS, colorDot } from '../lib/note-colors.js';

  export let params = {};

  $: path = ($location || '/').split('?')[0];
  $: view = path.startsWith('/archive') ? 'archive'
    : path.startsWith('/trash') ? 'trash'
    : path.startsWith('/reminders') ? 'reminders'
    : path.startsWith('/shared') ? 'shared'
    : 'notes';
  $: labelId = path.startsWith('/label/') ? Number(params?.id) : null;
  $: activeLabel = labelId != null ? $labelsById.get(labelId) : null;
  $: canCapture = view === 'notes' || view === 'reminders';
  // Timeline: a single column grouped by the day each note was last edited.
  $: timeline = $notesLayout === 'timeline' && view !== 'reminders';
  function dayLabel(day) {
    if (day.kind === 'today') return $_('timeline.today');
    if (day.kind === 'yesterday') return $_('timeline.yesterday');
    const opts = day.kind === 'week' ? { weekday: 'long', month: 'short', day: 'numeric' }
      : day.kind === 'year' ? { weekday: 'short', month: 'long', day: 'numeric' }
      : { month: 'long', day: 'numeric', year: 'numeric' };
    return day.date.toLocaleDateString(undefined, opts);
  }

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

  // ── Filter chips under search ─────────────────────────────────────
  let filters = emptyFilters();
  let searchFocused = false;
  let _blurTimer;
  $: filtering = hasFilters(filters);
  // Custom order applies to the grid in Notes, Shared with Me, and labels.
  $: orderable = (view === 'notes' || view === 'shared') && !timeline;
  const keyOf = (n) => noteKey(n, { native: isNative });
  $: ordered = orderable && $noteSort === 'custom' ? applyOrder(notes, $noteOrder, keyOf) : notes;
  $: filtered = filtering ? ordered.filter(n => matchesFilters(n, filters)) : ordered;
  function onReorder(e) {
    const keys = e.detail.ids.map(id => keyOf(notes.find(n => n.id === id))).filter(Boolean);
    if ($noteSort !== 'custom') {
      // First drag: keep everything else where it is on screen.
      noteOrder.set(mergeOrder(filtered.map(keyOf), keys));
      noteSort.set('custom');
      showInfo($_('notes.custom_order_on'));
    } else {
      noteOrder.set(mergeOrder($noteOrder, keys));
    }
  }
  $: showFilters = searchFocused || filtering || !!query;
  // A new view starts unfiltered.
  $: view, labelId, (filters = emptyFilters());
  $: filterLabels = $labels.filter(l => l.id !== labelId);
  function onSearchFocus() { clearTimeout(_blurTimer); searchFocused = true; }
  function onSearchBlur() { _blurTimer = setTimeout(() => { searchFocused = false; }, 160); }
  function flip(group, value) { filters = toggleFilter(filters, group, value); }

  $: pinned = view === 'notes' ? filtered.filter(n => n.pinned) : [];
  $: byNextReminder = view === 'reminders'
    ? [...filtered].sort((a, b) =>
        (nextOccurrence(a.reminder_at, a.reminder_rrule, a.reminder_tz) || 0) - (nextOccurrence(b.reminder_at, b.reminder_rrule, b.reminder_tz) || 0))
    : [];
  $: upcoming = byNextReminder.filter(n => !isPast(n.reminder_at, n.reminder_rrule));
  $: pastReminders = byNextReminder.filter(n => isPast(n.reminder_at, n.reminder_rrule)).reverse();
  $: others = view === 'notes' ? filtered.filter(n => !n.pinned) : view === 'reminders' ? upcoming : filtered;
  $: heading = activeLabel ? activeLabel.name
    : view === 'reminders' ? $_('routes.reminders.title')
    : view === 'archive' ? $_('routes.archive.title')
    : view === 'trash' ? $_('routes.trash.title')
    : view === 'shared' ? $_('routes.shared.title')
    : $_('routes.notes.title');

  async function load() {
    const seq = ++loadSeq;
    try {
      // A parent label ("Home") also shows notes from its nested labels ("Home/Garage").
      const ids = nestedIds;
      const nested = ids && ids.length > 1;
      let rows = await NoteApi.getNotes({ view, label: nested ? null : labelId, q: query.trim() });
      if (nested && Array.isArray(rows)) rows = rows.filter(n => (n.labels || []).some(id => ids.includes(id)));
      if (seq === loadSeq) notes = Array.isArray(rows) ? rows : [];
    } catch (e) {
      if (seq === loadSeq) showError(e.message || $_('notes.load_failed'));
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  $: nestedIds = labelId != null ? labelAndDescendantIds($labels, labelId) : null;
  $: nestedKey = nestedIds ? nestedIds.join() : '';
  // Reload whenever the view, label, or a background change says so.
  $: view, labelId, nestedKey, $notesChanged, load();

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

  // ── Multi-select ──────────────────────────────────────────────────
  // Ctrl/Cmd-click, the check on a card, or a long press starts selecting;
  // then clicks toggle, Shift-click selects a range, Escape clears.
  let selectedIds = new Set();
  let lastSelected = null;
  $: selecting = selectedIds.size > 0;
  $: selectedNotes = notes.filter(n => selectedIds.has(n.id));
  $: visibleOrder = [...pinned, ...others, ...(view === 'reminders' ? pastReminders : [])];
  $: view, labelId, clearSelection();
  // Drop selected notes that left the list (archived, trashed, synced away).
  $: pruneSelection(notes);
  function pruneSelection(list) {
    if (!selectedIds.size) return;
    const ids = new Set(list.map(n => n.id));
    if ([...selectedIds].some(id => !ids.has(id))) selectedIds = new Set([...selectedIds].filter(id => ids.has(id)));
  }
  function clearSelection() { selectedIds = new Set(); lastSelected = null; }
  function onSelect(e) {
    const { note, range } = e.detail;
    const next = new Set(selectedIds);
    if (range && lastSelected != null) {
      const ids = visibleOrder.map(n => n.id);
      const a = ids.indexOf(lastSelected), b = ids.indexOf(note.id);
      if (a >= 0 && b >= 0) for (const id of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(id);
    } else if (next.has(note.id)) next.delete(note.id);
    else next.add(note.id);
    selectedIds = next;
    lastSelected = note.id;
  }
  function selectAll() { selectedIds = new Set(visibleOrder.map(n => n.id)); }
  function onSelectKey(e) {
    if (e.key === 'Escape' && selecting && !editing) { e.preventDefault(); clearSelection(); return; }
    onShortcut(e);
  }

  // ── Keyboard shortcuts (? shows them all) ──────────────────────────
  let helpOpen = false;
  let _goPending = 0;
  const typingIn = (el) => !!el?.closest?.('input, textarea, select, [contenteditable="true"]');
  function focusedCard() {
    const el = document.activeElement?.closest?.('.note-card[data-note-id]');
    return el ? notes.find(n => n.id === Number(el.dataset.noteId)) : null;
  }
  function focusCardAt(step) {
    const els = visibleOrder.map(n => document.querySelector(`.note-card[data-note-id="${n.id}"]:not(.drag-ghost)`)).filter(Boolean);
    if (!els.length) return;
    const cur = els.indexOf(document.activeElement?.closest?.('.note-card'));
    const next = els[cur < 0 ? (step > 0 ? 0 : els.length - 1) : Math.max(0, Math.min(els.length - 1, cur + step))];
    next.focus();
    next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function onShortcut(e) {
    if (e.defaultPrevented || editing || e.altKey || typingIn(e.target)) return;
    if (document.querySelector('[role="dialog"][aria-modal="true"], .pop-backdrop, .as-backdrop')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      if (!visibleOrder.length) return;
      e.preventDefault(); selectAll(); return;
    }
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === '?') { e.preventDefault(); helpOpen = true; return; }
    if (!$keyboardShortcuts) return;
    if (Date.now() - _goPending < 1200) {
      _goPending = 0;
      const to = { n: '/', r: '/reminders', a: '/archive', t: '/trash', s: '/settings' }[e.key.toLowerCase()];
      if (to) { e.preventDefault(); pushRoute(to); }
      return;
    }
    const card = focusedCard();
    const targets = selecting ? selectedNotes : card ? [card] : [];
    switch (e.key) {
      case 'g': _goPending = Date.now(); break;
      case 'c': if (canCapture) { e.preventDefault(); newNote('text'); } break;
      case 'l': if (canCapture) { e.preventDefault(); newNote('checklist'); } break;
      case '/': e.preventDefault(); focusSearch(); break;
      case 'j': e.preventDefault(); focusCardAt(1); break;
      case 'k': e.preventDefault(); focusCardAt(-1); break;
      case 'x': if (card) { e.preventDefault(); onSelect({ detail: { note: card, range: false } }); } break;
      case 'f':
        if (targets.length && view === 'notes') {
          e.preventDefault();
          if (selecting) bulkPin(); else runAction(card, 'pin');
        }
        break;
      case 'e':
        if (targets.length && view !== 'trash') {
          e.preventDefault();
          const archivedNow = view === 'archive';
          if (selecting) bulkArchive(!archivedNow); else runAction(card, archivedNow ? 'unarchive' : 'archive');
        }
        break;
      case '#':
        if (targets.length && view !== 'trash') {
          e.preventDefault();
          if (selecting) bulkTrash(); else if (isOwner(card)) runAction(card, 'trash');
        }
        break;
    }
  }
  onMount(() => window.addEventListener('keydown', onSelectKey));
  onDestroy(() => window.removeEventListener('keydown', onSelectKey));

  $: allPinned = selectedNotes.length > 0 && selectedNotes.every(n => n.pinned);
  $: editableSel = selectedNotes.filter(canEdit);
  $: ownedSel = selectedNotes.filter(isOwner);
  let bulkBusy = false;
  async function bulk(fn, list, toastKey) {
    if (bulkBusy || !list.length) return;
    bulkBusy = true;
    let done = 0;
    try {
      for (const n of list) { await fn(n); done++; }
      if (toastKey) showInfo($_(toastKey, { values: { count: done } }));
    } catch (e) {
      showError(e.message || $_('notes.save_failed'));
    } finally {
      bulkBusy = false;
      clearSelection();
      signalNotesChanged();
      refreshLabels();
    }
  }
  const bulkPin = () => { const pin = !allPinned; return bulk(n => NoteApi.updateNote(n.id, { pinned: pin }), selectedNotes, pin ? 'select.toast_pinned' : 'select.toast_unpinned'); };
  const bulkArchive = (archived) => bulk(n => NoteApi.updateNote(n.id, { archived }), selectedNotes, archived ? 'select.toast_archived' : 'select.toast_unarchived');
  const bulkTrash = () => bulk(n => NoteApi.trashNote(n.id), ownedSel, 'select.toast_trashed');
  const bulkRestore = () => bulk(n => NoteApi.restoreNote(n.id), selectedNotes, 'select.toast_restored');
  async function bulkDeleteForever() {
    const ok = await confirmDialog({
      title: $_('select.delete_forever_title', { values: { count: selectedNotes.length } }),
      message: $_('notes.delete_forever_message'),
      confirmText: $_('notes.delete_forever'),
      dangerous: true,
    });
    if (ok) bulk(n => NoteApi.deleteNoteForever(n.id), selectedNotes, 'select.toast_deleted');
  }
  let bulkColorOpen = false, bulkColorAnchor = null;
  let bulkLabelOpen = false, bulkLabelAnchor = null;
  let bulkReminderOpen = false, bulkReminderAnchor = null;
  $: sharedLabels = selectedNotes.length ? selectedNotes.map(n => n.labels || []).reduce((acc, l) => acc.filter(id => l.includes(id))) : [];
  function bulkColor(c) { bulkColorOpen = false; bulk(n => NoteApi.updateNote(n.id, { color: c }), editableSel, null); }
  async function bulkLabels(next) {
    const added = next.filter(id => !sharedLabels.includes(id));
    const removed = sharedLabels.filter(id => !next.includes(id));
    const updates = [];
    for (const n of selectedNotes) {
      const cur = n.labels || [];
      const want = [...new Set([...cur.filter(id => !removed.includes(id)), ...added])];
      if (want.length !== cur.length || want.some(id => !cur.includes(id))) updates.push({ n, want });
    }
    try {
      for (const { n, want } of updates) replace(await NoteApi.updateNote(n.id, { labels: want }));
      refreshLabels();
    } catch (e) { showError(e.message); }
  }
  async function bulkReminder(detail) {
    bulkReminderOpen = false;
    await ensureReminderPermission();
    await bulk(n => NoteApi.updateNote(n.id, detail), ownedSel, 'select.toast_reminded');
    rescheduleReminders();
  }
  async function bulkClearReminder() {
    bulkReminderOpen = false;
    await bulk(n => NoteApi.updateNote(n.id, { reminder_at: null }), ownedSel, null);
    rescheduleReminders();
  }
  const anchorOf = (e) => e.currentTarget.getBoundingClientRect();

  // ── Swipe a card sideways to archive (touch screens) ──────────────
  const hasTouch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  $: swipeable = hasTouch && $swipeToArchive && !selecting && (view === 'notes' || view === 'shared' || view === 'archive');
  async function onSwipe(e) {
    const note = notes.find(n => n.id === e.detail.id);
    if (!note) return;
    const archived = view !== 'archive';
    notes = notes.filter(n => n.id !== note.id);
    try {
      await NoteApi.updateNote(note.id, { archived });
      showUndo($_(archived ? 'notes.toast_archived' : 'notes.toast_unarchived'), async () => {
        await NoteApi.updateNote(note.id, { archived: !archived }).catch(() => {});
        signalNotesChanged();
      }, $_('common.undo'));
    } catch (err) {
      showError(err.message || $_('notes.save_failed'));
      load();
    }
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
        on:focus={onSearchFocus} on:blur={onSearchBlur}
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
    <div class="toolbar-actions">
    {#if view !== 'reminders'}
      <button class="icon-btn layout-toggle" on:click={() => notesLayout.set(timeline ? 'grid' : 'timeline')}
        title={timeline ? $_('timeline.show_grid') : $_('timeline.show_timeline')}
        aria-label={timeline ? $_('timeline.show_grid') : $_('timeline.show_timeline')} aria-pressed={timeline}>
        <span class="material-symbols-rounded">{timeline ? 'grid_view' : 'view_timeline'}</span>
      </button>
    {/if}
    {#if view === 'trash' && notes.length}
      <button class="btn btn-secondary empty-trash" on:click={emptyTrash}>
        <span class="material-symbols-rounded">delete_sweep</span>{$_('notes.empty_trash')}
      </button>
    {/if}
    </div>
  </div>

  {#if showFilters}
    <div class="filter-bar" role="group" aria-label={$_('filters.title')} transition:slide={{ duration: 180 }}>
      {#each FILTER_TYPES as t (t.key)}
        {#if !(view === 'reminders' && t.key === 'reminders') && !(view === 'shared' && t.key === 'shared')}
          <button type="button" class="fchip" class:on={filters.types.includes(t.key)} aria-pressed={filters.types.includes(t.key)}
            on:mousedown|preventDefault on:click={() => flip('types', t.key)}>
            <span class="material-symbols-rounded">{t.icon}</span>{$_(t.label)}
          </button>
        {/if}
      {/each}
      <span class="fsep" aria-hidden="true"></span>
      {#each NOTE_COLORS.filter(c => c.value) as c (c.value)}
        <button type="button" class="fchip fcolor" class:on={filters.colors.includes(c.value)} aria-pressed={filters.colors.includes(c.value)}
          title={$_(`notes.color_${c.value}`)} aria-label={$_(`notes.color_${c.value}`)}
          on:mousedown|preventDefault on:click={() => flip('colors', c.value)}>
          <span class="fdot" style="background:{c.dot}"></span>
        </button>
      {/each}
      {#if filterLabels.length}
        <span class="fsep" aria-hidden="true"></span>
        {#each filterLabels as l (l.id)}
          <button type="button" class="fchip" class:on={filters.labels.includes(l.id)} aria-pressed={filters.labels.includes(l.id)}
            on:mousedown|preventDefault on:click={() => flip('labels', l.id)}>
            <span class="fdot small" style="background:{colorDot(l.color)}"></span>{l.name}
          </button>
        {/each}
      {/if}
      {#if filtering}
        <button type="button" class="fchip fclear" on:mousedown|preventDefault on:click={() => filters = emptyFilters()}>
          <span class="material-symbols-rounded">filter_alt_off</span>{$_('filters.clear')}
        </button>
      {/if}
    </div>
  {/if}

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
    {:else if !filtered.length}
      <div class="empty">
        <span class="material-symbols-rounded empty-icon">
          {query || filtering ? 'search_off' : view === 'reminders' ? 'notifications' : view === 'archive' ? 'archive' : view === 'trash' ? 'delete' : view === 'shared' ? 'group' : activeLabel ? 'label' : 'sticky_note_2'}
        </span>
        <h2>
          {query || filtering ? $_('notes.empty_search_title')
            : view === 'reminders' ? $_('routes.reminders.empty_title')
            : view === 'archive' ? $_('routes.archive.empty_title')
            : view === 'trash' ? $_('routes.trash.empty_title')
            : view === 'shared' ? $_('routes.shared.empty_title')
            : activeLabel ? $_('routes.label.empty_title')
            : $_('routes.notes.empty_title')}
        </h2>
        <p>
          {query || filtering ? $_('notes.empty_search_body')
            : view === 'reminders' ? $_('routes.reminders.empty_body')
            : view === 'archive' ? $_('routes.archive.empty_body')
            : view === 'trash' ? $_('routes.trash.empty_body')
            : view === 'shared' ? $_('routes.shared.empty_body')
            : activeLabel ? $_('routes.label.empty_body')
            : $_('routes.notes.empty_body')}
        </p>
      </div>
    {:else if timeline}
      {#if pinned.length}
        <section class="notes-section timeline">
          <h2 class="section-label"><span class="material-symbols-rounded fill">keep</span>{$_('notes.pinned')}</h2>
          <div class="timeline-list">
            {#each pinned as n (n.id)}<NoteCard note={n} {view} selected={selectedIds.has(n.id)} {selecting} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} on:select={onSelect} />{/each}
          </div>
        </section>
      {/if}
      {#each groupByDay(others) as day (day.key)}
        <section class="notes-section timeline">
          <h2 class="section-label"><span class="material-symbols-rounded">calendar_today</span>{dayLabel(day)}</h2>
          <div class="timeline-list">
            {#each day.notes as n (n.id)}<NoteCard note={n} {view} selected={selectedIds.has(n.id)} {selecting} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} on:select={onSelect} />{/each}
          </div>
        </section>
      {/each}
    {:else}
      {#if pinned.length}
        <section class="notes-section">
          <h2 class="section-label"><span class="material-symbols-rounded fill">keep</span>{$_('notes.pinned')}</h2>
          <NoteGrid notes={pinned} {view} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} on:select={onSelect} selectedIds={selectedIds} {selecting} draggable={orderable && !selectedIds.size} on:reorder={onReorder} {swipeable} on:swipe={onSwipe} />
        </section>
      {/if}
      {#if others.length}
        <section class="notes-section">
          {#if pinned.length}<h2 class="section-label">{$_('notes.others')}</h2>{/if}
          {#if view === 'reminders' && pastReminders.length}<h2 class="section-label">{$_('reminders.upcoming')}</h2>{/if}
          <NoteGrid notes={others} {view} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} on:select={onSelect} selectedIds={selectedIds} {selecting} draggable={orderable && !selectedIds.size} on:reorder={onReorder} {swipeable} on:swipe={onSwipe} />
        </section>
      {/if}
      {#if view === 'reminders' && pastReminders.length}
        <section class="notes-section">
          <h2 class="section-label">{$_('reminders.past')}</h2>
          <NoteGrid notes={pastReminders} {view} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} on:select={onSelect} selectedIds={selectedIds} {selecting} draggable={orderable && !selectedIds.size} on:reorder={onReorder} {swipeable} on:swipe={onSwipe} />
        </section>
      {/if}
    {/if}
  </div>

  {#if canCapture}
    <button class="fab" class:hidden-fab={selecting} on:click={() => newNote('text')} aria-label={$_('notes.new_note')}>
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
{#if selecting}
  <div class="bulk-bar" role="toolbar" aria-label={$_('select.toolbar')} transition:fly={{ y: 24, duration: 220 }}>
    <button class="bulk-btn" on:click={clearSelection} title={$_('select.clear')} aria-label={$_('select.clear')}>
      <span class="material-symbols-rounded">close</span>
    </button>
    <span class="bulk-count" aria-live="polite">{$_('select.count', { values: { count: selectedIds.size } })}</span>
    <span class="bulk-spacer"></span>
    {#if view === 'trash'}
      <button class="bulk-btn" on:click={bulkRestore} disabled={bulkBusy} title={$_('notes.restore')} aria-label={$_('notes.restore')}>
        <span class="material-symbols-rounded">restore_from_trash</span>
      </button>
      <button class="bulk-btn danger" on:click={bulkDeleteForever} disabled={bulkBusy} title={$_('notes.delete_forever')} aria-label={$_('notes.delete_forever')}>
        <span class="material-symbols-rounded">delete_forever</span>
      </button>
    {:else}
      {#if view === 'notes'}
        <button class="bulk-btn" on:click={bulkPin} disabled={bulkBusy} title={allPinned ? $_('notes.unpin') : $_('notes.pin')} aria-label={allPinned ? $_('notes.unpin') : $_('notes.pin')}>
          <span class="material-symbols-rounded" class:fill={allPinned}>keep</span>
        </button>
      {/if}
      {#if ownedSel.length}
        <button class="bulk-btn" on:click={(e) => { bulkReminderAnchor = anchorOf(e); bulkReminderOpen = true; }} disabled={bulkBusy} title={$_('reminders.remind_me')} aria-label={$_('reminders.remind_me')}>
          <span class="material-symbols-rounded">notification_add</span>
        </button>
      {/if}
      {#if editableSel.length}
        <button class="bulk-btn" on:click={(e) => { bulkColorAnchor = anchorOf(e); bulkColorOpen = true; }} disabled={bulkBusy} title={$_('notes.color')} aria-label={$_('notes.color')}>
          <span class="material-symbols-rounded">palette</span>
        </button>
      {/if}
      <button class="bulk-btn" on:click={(e) => { bulkLabelAnchor = anchorOf(e); bulkLabelOpen = true; }} disabled={bulkBusy} title={$_('notes.labels')} aria-label={$_('notes.labels')}>
        <span class="material-symbols-rounded">label</span>
      </button>
      {#if view === 'archive'}
        <button class="bulk-btn" on:click={() => bulkArchive(false)} disabled={bulkBusy} title={$_('notes.unarchive')} aria-label={$_('notes.unarchive')}>
          <span class="material-symbols-rounded">unarchive</span>
        </button>
      {:else}
        <button class="bulk-btn" on:click={() => bulkArchive(true)} disabled={bulkBusy} title={$_('notes.archive')} aria-label={$_('notes.archive')}>
          <span class="material-symbols-rounded">archive</span>
        </button>
      {/if}
      {#if ownedSel.length}
        <button class="bulk-btn" on:click={bulkTrash} disabled={bulkBusy} title={$_('notes.move_to_trash')} aria-label={$_('notes.move_to_trash')}>
          <span class="material-symbols-rounded">delete</span>
        </button>
      {/if}
    {/if}
    <span class="bulk-divider" aria-hidden="true"></span>
    <button class="bulk-btn" on:click={selectAll} title={$_('select.all')} aria-label={$_('select.all')}>
      <span class="material-symbols-rounded">select_all</span>
    </button>
  </div>
{/if}
<Popover bind:open={bulkColorOpen} anchor={bulkColorAnchor}>
  <ColorPalette value={null} on:select={(e) => bulkColor(e.detail)} />
</Popover>
<Popover bind:open={bulkLabelOpen} anchor={bulkLabelAnchor}>
  <LabelPicker selected={sharedLabels} on:change={(e) => bulkLabels(e.detail)} />
</Popover>
<Popover bind:open={bulkReminderOpen} anchor={bulkReminderAnchor}>
  <ReminderPicker reminderAt={null} repeat={null} tz={null} on:set={(e) => bulkReminder(e.detail)} on:clear={bulkClearReminder} />
</Popover>
<ShortcutsHelp bind:open={helpOpen} />
<ActionSheet bind:open={menuOpen} title={menuNote?.title || ''} actions={menuActions} on:select={onMenuSelect} />

<style>
  .bulk-bar {
    position: fixed; z-index: 150;
    bottom: calc(var(--safe-bottom) + 24px);
    left: calc(var(--sidebar-w, 0px) + 12px); right: 12px;
    max-width: 720px; margin: 0 auto;
    height: 52px; padding: 0 8px;
    display: flex; align-items: center; gap: 2px;
    border-radius: var(--radius-lg);
    background: var(--glass-surface);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    box-shadow: var(--shadow-lg), 0 0 0 4px var(--accent-dim);
  }
  .bulk-count { font-size: 15px; font-weight: 600; color: var(--text-1); padding: 0 6px; white-space: nowrap; }
  .bulk-spacer { flex: 1; }
  .bulk-divider { width: 1px; height: 22px; background: var(--border); margin: 0 4px; }
  .bulk-btn {
    width: 40px; height: 40px; flex-shrink: 0; border-radius: 11px;
    display: flex; align-items: center; justify-content: center; color: var(--text-2);
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .bulk-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--text-1) 9%, transparent); color: var(--text-1); }
  .bulk-btn:disabled { opacity: 0.5; }
  .bulk-btn.danger { color: var(--danger); }
  @media (max-width: 600px) {
    .bulk-bar { left: 8px; right: 8px; bottom: calc(var(--nav-h) + var(--safe-bottom) + 10px); padding: 0 4px; }
    .bulk-bar { gap: 0; }
    .bulk-btn { width: 36px; }
    .bulk-count { font-size: 14px; padding: 0 2px; }
    .bulk-divider { margin: 0 2px; }
  }

  .layout-toggle { width: 44px; height: 44px; flex-shrink: 0; border-radius: var(--radius-md); color: var(--text-2); display: flex; align-items: center; justify-content: center; }
  .layout-toggle:hover { background: color-mix(in srgb, var(--text-1) 8%, transparent); color: var(--text-1); }
  .timeline-list { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 720px; margin: 0 auto; }
  .notes-section.timeline { width: 100%; }
  .notes-section.timeline .section-label { max-width: 720px; margin-left: auto; margin-right: auto; }

  .notes-page { --notes-max: 1680px; }
  /* Search sits on the same center line and width as the capture bar, with
     the view buttons to its right. Phones stack it as a plain row. */
  .notes-toolbar {
    display: grid; grid-template-columns: 1fr minmax(0, 600px) 1fr; align-items: center; gap: 12px;
    padding: 12px var(--page-px) 0;
    max-width: var(--notes-max); margin: 0 auto; width: 100%;
  }
  .toolbar-actions { grid-column: 3; justify-self: start; display: flex; align-items: center; gap: 8px; }
  .search {
    grid-column: 2; width: 100%;
    transition: border-color var(--dur-fast), box-shadow var(--dur-fast), background var(--dur-fast);
    height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 8px 0 14px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-md);
    color: var(--text-3);
  }
  .search:focus-within { border-color: var(--accent); background: var(--surface-1); box-shadow: 0 0 0 4px var(--accent-dim); }
  .search input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--text-1); font-size: 15px; }
  .search input::-webkit-search-cancel-button { display: none; }
  .search-clear { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
  .search-clear:hover { color: var(--text-1); background: color-mix(in srgb, var(--text-1) 8%, transparent); }
  .empty-trash { height: 44px; }

  .filter-bar {
    display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 6px;
    max-width: min(var(--notes-max), 980px); margin: 10px auto 0; width: 100%;
    padding: 0 var(--page-px);
  }
  .fchip {
    height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 12px 0 10px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-2); font-size: 13px; font-weight: 500;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast), transform 120ms ease;
  }
  .fchip .material-symbols-rounded { font-size: 17px; }
  .fchip:hover { border-color: var(--border-strong); color: var(--text-1); }
  .fchip:active { transform: scale(0.96); }
  .fchip.on {
    background: var(--accent-dim); color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .fchip.fcolor { width: 32px; padding: 0; justify-content: center; }
  .fchip.fcolor.on { box-shadow: 0 0 0 2px var(--accent); }
  .fdot { width: 14px; height: 14px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.15); }
  .fdot.small { width: 8px; height: 8px; box-shadow: none; }
  .fclear { color: var(--text-3); border-style: dashed; }
  .fsep { width: 1px; height: 18px; background: var(--border); margin: 0 4px; }
  @media (max-width: 600px) {
    .filter-bar { flex-wrap: nowrap; justify-content: flex-start; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
    .filter-bar::-webkit-scrollbar { display: none; }
    .fchip { flex-shrink: 0; }
  }

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
    transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
  }
  .capture:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-strong)); box-shadow: var(--shadow-md), 0 0 0 4px var(--accent-dim); }
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
  .fab.hidden-fab { visibility: hidden; }
  @media (max-width: 600px) {
    .notes-toolbar { display: flex; }
    .search { flex: 1; }
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
