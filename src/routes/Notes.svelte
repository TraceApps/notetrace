<script>
  /**
   * Notes: the notes grid and its sibling views.
   *   /            notes (pinned + others, with capture)
   *   /reminders   notes with a reminder, soonest first
   *   /archive     archived notes
   *   /trash       trashed notes (auto-deleted after 30 days)
   *   /label/:id   notes carrying one label
   */
  import { onMount, onDestroy, tick, afterUpdate } from 'svelte';
  import { slide, fly, fade } from 'svelte/transition';
  import { location, querystring, replace as replaceRoute } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { bannerStyle } from '../stores/settings.js';
  import { NoteApi } from '../lib/api.js';
  import { labels, labelsById, notesChanged, refreshLabels, signalNotesChanged, signalCountsChanged } from '../stores/notes.js';
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
  import { notesLayout, noteSort, noteOrder, keyboardShortcuts, swipeToArchive, listGroupBy, listColumnWidth, notesLayoutBySize } from '../stores/settings.js';
  import { sizeClass, contentWidth, viewport } from '../stores/window-size.js';
  import { fold } from '../lib/fold.js';
  import NoteRow from '../components/notes/NoteRow.svelte';
  import { groupNotes } from '../lib/list-groups.js';
  import { showUndo } from '../stores/toast.js';
  import ShortcutsHelp from '../components/notes/ShortcutsHelp.svelte';
  import { push as pushRoute } from 'svelte-spa-router';
  import { noteKey, applyOrder, mergeOrder } from '../lib/note-order.js';
  import { labelAndDescendantIds } from '../lib/label-tree.js';
  import { isNative } from '../lib/platform.js';
  import NoteCard from '../components/notes/NoteCard.svelte';
  import { pendingShare, shareToNote, takeSharedFiles } from '../lib/share-intent.js';
  import { FILTER_TYPES, emptyFilters, hasFilters, matchesFilters, toggleFilter } from '../lib/note-filters.js';
  import { recordingSupported } from '../lib/voice-recorder.js';
  import { longpress } from '../lib/long-press.js';
  import { growOnScroll } from '../lib/grow-on-scroll.js';
  import { searchTerms } from '../lib/highlight.js';
  import { portal } from '../lib/portal.js';
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
  // Each screen size keeps its own layout, so a foldable can show a grid
  // folded and the List layout unfolded. Unset sizes use the last one picked.
  $: layout = ($notesLayoutBySize || {})[$sizeClass] || $notesLayout || 'grid';
  async function setLayout(value) {
    // Picking another layout closes the note in the pane rather than moving it over the page.
    if (pane && value !== 'list') await movePaneToOverlay(false);
    notesLayoutBySize.set({ ...($notesLayoutBySize || {}), [$sizeClass]: value });
    notesLayout.set(value);
  }
  $: timeline = layout === 'timeline' && view !== 'reminders';
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
  // Search lives in the page banner: the search button (or / or Ctrl+K)
  // turns the banner into a search field, with filter chips underneath.
  let searchOpen = false;
  $: if (query || filtering) searchOpen = true;
  $: showFilters = searchOpen;
  async function openSearch() {
    searchOpen = true;
    await tick();
    searchEl?.focus();
    searchEl?.select();
  }
  // ── Recent searches ────────────────────────────────────────────────
  const RECENTS_KEY = 'note:recentSearches';
  let recents = [];
  try { recents = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]').filter(s => typeof s === 'string'); } catch { recents = []; }
  function rememberSearch(q) {
    const clean = String(q || '').trim();
    if (clean.length < 2) return;
    recents = [clean, ...recents.filter(r => r.toLowerCase() !== clean.toLowerCase())].slice(0, 8);
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recents)); } catch { /* private mode */ }
  }
  function clearRecents() {
    recents = [];
    try { localStorage.removeItem(RECENTS_KEY); } catch { /* private mode */ }
  }
  function useRecent(q) {
    query = q;
    onSearch();
    searchEl?.focus();
  }
  // What the search box matched, marked on the cards.
  $: terms = searchOpen ? searchTerms(query) : [];

  function closeSearch() {
    const had = !!query;
    rememberSearch(query);
    query = '';
    filters = emptyFilters();
    searchOpen = false;
    if (had) load();
  }
  let viewOpen = false, viewAnchor = null;
  // A new view starts unfiltered.
  $: view, labelId, (filters = emptyFilters());
  $: filterLabels = $labels.filter(l => l.id !== labelId);
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
  const focusSearch = () => { openSearch(); };
  onMount(() => {
    refreshLabels();
    window.addEventListener('note:focus-search', focusSearch);
  });
  onDestroy(() => {
    clearTimeout(searchTimer);
    window.removeEventListener('note:focus-search', focusSearch);
  });

  // ── Editor ─────────────────────────────────────────────────────────
  // ── List layout: notes on the left, the open note on the right ─────
  // With room for two panes (an unfolded foldable beside the icon rail, or
  // a desktop) the List layout opens notes beside the list; otherwise they
  // open over the page like the grid does.
  $: listMode = layout === 'list' && view !== 'reminders';
  $: splitPane = listMode && $contentWidth >= 740;
  let pane = null;      // { note } or { kind, labels } in the reading pane
  // The workspace (list column + reading pane) fills the screen below the banner;
  // each side scrolls on its own.
  let workEl, workH = 600;
  function sizeWork() {
    if (!workEl) return;
    const top = Math.max(0, workEl.getBoundingClientRect().top);
    const tabbar = document.querySelector('.bottom-nav')?.offsetHeight || 0;
    const h = Math.max(420, Math.round(window.innerHeight - top - tabbar));
    if (h !== workH) workH = h;
  }
  afterUpdate(sizeWork);
  onMount(() => window.addEventListener('resize', sizeWork));
  onDestroy(() => window.removeEventListener('resize', sizeWork));

  // The list column's width: drag the divider, arrow keys on it, double-click to reset.
  const LIST_W = { min: 280, max: 560, default: 360 };
  $: listW = Math.max(LIST_W.min, Math.min(LIST_W.max, $contentWidth - 380, Number($listColumnWidth) || LIST_W.default));
  // Half open like a book, the list fills the left side of the fold and the note the right.
  $: foldListW = $fold?.posture === 'book' ? $fold.start - ($viewport.width - $contentWidth) : null;
  $: foldSnap = splitPane && foldListW != null && foldListW >= 240 && $contentWidth - foldListW >= 300;
  $: workListW = foldSnap ? foldListW : listW;
  $: hingeW = foldSnap ? Math.max(0, $fold.end - $fold.start) : 0;
  let resizing = null;
  function startResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    resizing = { x: e.clientX, w: listW };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function onResizeMove(e) {
    if (!resizing) return;
    const room = (workEl?.clientWidth || 1200) - 420;
    listColumnWidth.set(Math.round(Math.min(room, LIST_W.max, Math.max(LIST_W.min, resizing.w + e.clientX - resizing.x))));
  }
  function endResize() { resizing = null; }
  function resizeKey(e) {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') { e.preventDefault(); listColumnWidth.set(Math.max(LIST_W.min, listW - step)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); listColumnWidth.set(Math.min(LIST_W.max, listW + step)); }
    if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); listColumnWidth.set(LIST_W.default); }
  }
  // Up and Down move through the rows and open each one.
  function listKeys(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const row = e.target.closest?.('.note-row');
    if (!row) return;
    const rows = [...workEl.querySelectorAll('.list-scroll .note-row')];
    const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.click();
  }
  let newOpen = false, newAnchor = null;
  let paneKey = 0;
  let paneRef;
  async function openInPane(entry) {
    const hadPane = !!pane;
    try { await paneRef?.flush?.(); } catch { /* keep going */ }
    pane = entry;
    paneKey++;
    if (hadPane) load();   // the note just left may have changed
  }
  async function closePane(e) {
    const target = e?.detail?.navigate;
    pane = null;
    load();
    if (target) {
      await tick();
      try { const n = await NoteApi.getNote(target); if (n) openInPane({ note: n }); } catch { /* gone */ }
    }
  }
  // Unfolding with a note open full screen moves it into the pane, and folding
  // moves it back, keeping what was typed.
  let overlayRef;
  let moving = false;
  async function _openedNote(ref, entry) {
    try { await ref?.flush?.(); } catch { /* keep going */ }
    const id = ref?.currentNoteId?.() ?? entry?.note?.id ?? null;
    if (id == null) return null;
    try { return await NoteApi.getNote(id); } catch { return null; }
  }
  async function moveOverlayToPane() {
    moving = true;
    const entry = editing;
    const note = await _openedNote(overlayRef, entry);
    editing = null;
    pane = note ? { note } : { kind: entry.kind || 'text', labels: entry.labels || [], prefill: entry.prefill || null };
    paneKey++;
    moving = false;
    load();
  }
  async function movePaneToOverlay(reopen) {
    moving = true;
    const note = await _openedNote(paneRef, pane);
    pane = null;
    if (reopen && note) editing = { note };
    moving = false;
    load();
  }
  $: if (splitPane && editing && !moving) moveOverlayToPane();
  $: if (!splitPane && pane && !moving) movePaneToOverlay(true);
  // Long libraries draw a screenful at a time and add more as you scroll, so a
  // few thousand notes don't all land in the page at once.
  const PAGE = 60;
  let shown = PAGE;
  // Switching view, searching, or filtering starts at the top again. Note edits
  // and sync don't: they'd throw away how far the list has been scrolled.
  $: view, labelId, query, filters, (shown = PAGE);
  $: windowed = filtered.slice(0, shown);
  $: othersShown = others.slice(0, shown);
  $: moreToShow = shown < (listMode ? filtered.length : others.length);
  const showMore = () => { if (moreToShow) shown += PAGE; };
  $: listGroups = listMode ? groupNotes(windowed, $listGroupBy, { labels: $labels, pinnedFirst: view === 'notes' }) : [];
  function groupTitle(g) {
    if (g.kind === 'pinned') return $_('notes.pinned');
    if (g.kind === 'others') return $_('notes.others');
    if (g.kind === 'label') return g.label.name;
    if (g.kind === 'no-label') return $_('list.no_label');
    if (g.kind === 'color') return $_(`notes.color_${g.color || 'default'}`);
    if (g.kind === 'day') return dayLabel(g.day);
    return '';
  }

  $: emptyIcon = query || filtering ? 'search_off' : view === 'reminders' ? 'notifications' : view === 'archive' ? 'archive' : view === 'trash' ? 'delete' : view === 'shared' ? 'group' : activeLabel ? 'label' : 'sticky_note_2';
  $: [emptyTitle, emptyBody] = query || filtering ? ['notes.empty_search_title', 'notes.empty_search_body']
    : view === 'reminders' ? ['routes.reminders.empty_title', 'routes.reminders.empty_body']
    : view === 'archive' ? ['routes.archive.empty_title', 'routes.archive.empty_body']
    : view === 'trash' ? ['routes.trash.empty_title', 'routes.trash.empty_body']
    : view === 'shared' ? ['routes.shared.empty_title', 'routes.shared.empty_body']
    : activeLabel ? ['routes.label.empty_title', 'routes.label.empty_body']
    : ['routes.notes.empty_title', 'routes.notes.empty_body'];

  function openNote(e) {
    if (splitPane) openInPane({ note: e.detail });
    else editing = { note: e.detail, originId: e.detail.id };
  }
  let captureImageInput;
  function newNoteWithImages(files) {
    const entry = { kind: 'text', labels: labelId != null ? [labelId] : [], prefill: { images: files } };
    if (splitPane) openInPane(entry);
    else editing = entry;
  }
  function newNote(kind = 'text') {
    const entry = { kind, labels: labelId != null ? [labelId] : [] };
    if (splitPane) openInPane(entry);
    else editing = entry;
  }
  // A quick voice note: a new note that opens straight into recording.
  const canRecordVoice = recordingSupported();
  function newVoiceNote() {
    if (!canRecordVoice) return;
    const entry = { kind: 'text', labels: labelId != null ? [labelId] : [], voice: true };
    if (splitPane) openInPane(entry);
    else editing = entry;
  }
  // On a phone the + button sits in the corner, so Trace's button stacks above it.
  // A phone, upright or on its side, starts notes from the + button; wider or taller
  // screens use the Take a note bar. Kept in step with the media query in the styles.
  const PHONE_CAPTURE = '(max-width: 600px), (pointer: coarse) and (max-height: 500px)';
  $: phoneCapture = typeof window !== 'undefined' && ($viewport, !!window.matchMedia?.(PHONE_CAPTURE).matches);
  $: if (typeof document !== 'undefined') document.documentElement.style.setProperty('--page-fab-space', canCapture && phoneCapture ? '76px' : '0px');
  onDestroy(() => document.documentElement.style.setProperty('--page-fab-space', '0px'));
  // Holding the + button on a phone starts a voice note instead of a text note.
  let fabHeld = false;
  // On a phone the + button opens a small menu (text, list, voice, image), like
  // Google Keep; holding it goes straight to a voice note.
  let fabMenu = false;
  function onFabClick() {
    if (fabHeld) { fabHeld = false; return; }
    fabMenu = !fabMenu;
  }
  function fromFabMenu(action) {
    fabMenu = false;
    action();
  }
  $: if (selecting || editing) fabMenu = false;

  // Opened from a reminder notification: /?note=<id>
  $: openFromQuery($querystring);
  async function openFromQuery(qs) {
    const params = new URLSearchParams(qs || '');
    // Home screen shortcuts: /?new=text|checklist|voice
    const fresh = params.get('new');
    if (fresh) {
      replaceRoute(path);
      await tick();
      if (fresh === 'voice') newVoiceNote();
      else newNote(fresh === 'checklist' ? 'checklist' : 'text');
      return;
    }
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
      signalCountsChanged();   // the Tasks badge, without reloading the list
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
  $: visibleOrder = listMode
    ? [...new Map(listGroups.flatMap(g => g.notes).map(n => [n.id, n])).values()]
    : [...pinned, ...others, ...(view === 'reminders' ? pastReminders : [])];
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
    const el = document.activeElement?.closest?.('[data-note-id]');
    return el ? notes.find(n => n.id === Number(el.dataset.noteId)) : null;
  }
  async function focusCardAt(step) {
    const els = visibleOrder.map(n => document.querySelector(`[data-note-id="${n.id}"]:not(.drag-ghost)`)).filter(Boolean);
    if (!els.length) return;
    const cur = els.indexOf(document.activeElement?.closest?.('[data-note-id]'));
    // At the end of what's drawn so far, draw more and keep going.
    if (cur >= 0 && step > 0 && cur + step > els.length - 1 && moreToShow) {
      showMore();
      await tick();
      return focusCardAt(step);
    }
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
      case 'v': if (canCapture && canRecordVoice) { e.preventDefault(); newVoiceNote(); } break;
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

<div class="page-shell notes-page" class:workspace-page={splitPane && !loading}>
  <header class="page-header notes-header" class:searching={searchOpen} class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    {#if searchOpen}
      <div class="header-search" role="search" in:fade={{ duration: 140 }}>
        <span class="material-symbols-rounded">search</span>
        <input type="search" bind:this={searchEl} placeholder={$_('notes.search_in', { values: { view: heading } })} bind:value={query} on:input={onSearch}
          on:keydown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
            else if (e.key === 'Enter') { rememberSearch(query); searchEl?.blur(); }
          }}
          aria-label={$_('notes.search_placeholder')} />
        {#if !query}<kbd class="search-kbd" aria-hidden="true">{shortcutLabel}</kbd>{/if}
        <button class="btn-icon header-btn" on:click={closeSearch} title={$_('notes.close_search')} aria-label={$_('notes.close_search')}>
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>
    {:else}
      <h1>{heading}</h1>
      <div class="header-actions" in:fade={{ duration: 140 }}>
        <button class="btn-icon header-btn" on:click={openSearch} title="{$_('notes.search_placeholder')} ({shortcutLabel})" aria-label={$_('notes.search_placeholder')}>
          <span class="material-symbols-rounded">search</span>
        </button>
        {#if view !== 'reminders'}
          <button class="btn-icon header-btn" on:click={(e) => { viewAnchor = e.currentTarget.getBoundingClientRect(); viewOpen = true; }}
            title={$_('list.view_options')} aria-label={$_('list.view_options')} aria-haspopup="menu">
            <span class="material-symbols-rounded">{listMode ? 'view_list' : timeline ? 'view_timeline' : 'grid_view'}</span>
          </button>
        {/if}
      </div>
    {/if}
  </header>

  {#if searchOpen && !query && recents.length}
    <div class="recent-bar" transition:slide={{ duration: 160 }}>
      <span class="recent-label">{$_('notes.recent_searches')}</span>
      {#each recents as r (r)}
        <button type="button" class="fchip" on:mousedown|preventDefault on:click={() => useRecent(r)}>
          <span class="material-symbols-rounded">history</span>{r}
        </button>
      {/each}
      <button type="button" class="fchip fclear" on:mousedown|preventDefault on:click={clearRecents}>{$_('notes.clear_recent')}</button>
    </div>
  {/if}
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

  <div class="notes-body" class:workspace-body={splitPane && !loading}>
    {#if canCapture && !searchOpen && !splitPane}
      <div class="capture" role="group" aria-label={$_('notes.take_a_note')}>
        <button class="capture-main" on:click={() => newNote('text')}>{$_('notes.take_a_note')}</button>
        <button class="capture-icon" on:click={() => newNote('checklist')} title={$_('notes.new_checklist')} aria-label={$_('notes.new_checklist')}>
          <span class="material-symbols-rounded">check_box</span>
        </button>
        {#if canRecordVoice}
          <button class="capture-icon" on:click={newVoiceNote} title={$_('notes.new_voice_note')} aria-label={$_('notes.new_voice_note')}>
            <span class="material-symbols-rounded">mic</span>
          </button>
        {/if}
        <button class="capture-icon" on:click={() => captureImageInput.click()} title={$_('notes.new_with_image')} aria-label={$_('notes.new_with_image')}>
          <span class="material-symbols-rounded">add_photo_alternate</span>
        </button>
      </div>
    {/if}
    <input bind:this={captureImageInput} type="file" accept="image/*" multiple hidden
      on:change={(e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) newNoteWithImages(files); }} />

    {#if view === 'trash'}
      <div class="trash-note">
        <p>{$_('notes.trash_retention')}</p>
        {#if notes.length}
          <button class="btn btn-secondary empty-trash" on:click={emptyTrash}>
            <span class="material-symbols-rounded">delete_sweep</span>{$_('notes.empty_trash')}
          </button>
        {/if}
      </div>
    {/if}

    {#if loading}
      <div class="skeleton-grid" aria-hidden="true">
        {#each Array(6) as _s, i}<div class="skeleton" style="height:{120 + (i % 3) * 50}px"></div>{/each}
      </div>
    {:else if splitPane}
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="workspace" bind:this={workEl} class:resizing={!!resizing} class:fold-snap={foldSnap} style="height:{workH}px; --list-w:{workListW}px; --hinge:{hingeW}px">
        <div class="list-col">
          <div class="list-head">
            <span class="list-count">{$_('list.note_count', { values: { count: filtered.length } })}</span>
            {#if canCapture}
              <div class="new-split">
                <button class="new-main" on:click={() => newNote('text')}>
                  <span class="material-symbols-rounded">add</span>{$_('notes.new_note')}
                </button>
                <button class="new-more" on:click={(e) => { newAnchor = e.currentTarget.getBoundingClientRect(); newOpen = true; }}
                  title={$_('list.more_new')} aria-label={$_('list.more_new')} aria-haspopup="menu">
                  <span class="material-symbols-rounded">expand_more</span>
                </button>
              </div>
            {/if}
          </div>
          <div class="list-scroll" on:keydown={listKeys}>
            {#if !filtered.length}
              <div class="list-empty">
                <span class="material-symbols-rounded">{emptyIcon}</span>
                <strong>{$_(emptyTitle)}</strong>
                <p>{$_(emptyBody)}</p>
              </div>
            {:else}
              {#each listGroups as g (g.key)}
                <section class="list-section">
                  {#if g.kind !== 'all'}
                    <h2 class="section-label">
                      {#if g.kind === 'pinned'}<span class="material-symbols-rounded fill">keep</span>{/if}
                      {#if g.kind === 'label' || g.kind === 'color'}<span class="group-dot" style="background:{g.kind === 'label' ? colorDot(g.label.color) : colorDot(g.color)}"></span>{/if}
                      {groupTitle(g)}
                      <span class="group-count">{g.notes.length}</span>
                    </h2>
                  {/if}
                  {#each g.notes as n (g.key + ':' + n.id)}
                    <NoteRow note={n} {terms} current={pane?.note?.id === n.id} selected={selectedIds.has(n.id)} {selecting}
                      on:open={openNote} on:select={onSelect} />
                  {/each}
                </section>
              {/each}
              {#if moreToShow}<div class="more-marker" use:growOnScroll={{ onGrow: showMore }} aria-hidden="true"></div>{/if}
            {/if}
          </div>
        </div>
        <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
        <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
        <div class="list-resizer" role="separator" aria-orientation="vertical" aria-valuemin={LIST_W.min} aria-valuemax={LIST_W.max} aria-valuenow={listW}
          aria-label={$_('list.resize')} title={$_('list.resize')} tabindex="0"
          on:pointerdown={startResize} on:pointermove={onResizeMove} on:pointerup={endResize} on:pointercancel={endResize}
          on:dblclick={() => listColumnWidth.set(LIST_W.default)} on:keydown={resizeKey}></div>
        <div class="pane">
          {#if pane}
            {#key paneKey}
              <NoteEditor bind:this={paneRef} inline autoRecord={!!pane.voice} note={pane.note || null} initialKind={pane.kind || 'text'}
                initialLabels={pane.labels || []} prefill={pane.prefill || null} on:close={closePane} />
            {/key}
          {:else}
            <div class="pane-empty">
              <span class="material-symbols-rounded">description</span>
              <p>{$_('list.select_note')}</p>
              {#if canCapture}
                <div class="pane-empty-actions">
                  <button class="btn btn-secondary" on:click={() => newNote('text')}>
                    <span class="material-symbols-rounded">add</span>{$_('notes.new_note')}
                  </button>
                  <button class="btn btn-secondary" on:click={() => newNote('checklist')}>
                    <span class="material-symbols-rounded">checklist</span>{$_('notes.new_checklist')}
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {:else if !filtered.length}
      <div class="empty">
        <span class="material-symbols-rounded empty-icon">{emptyIcon}</span>
        <h2>{$_(emptyTitle)}</h2>
        <p>{$_(emptyBody)}</p>
      </div>
    {:else if listMode}
      <div class="list-col list-card">
        {#each listGroups as g (g.key)}
          <section class="list-section">
            {#if g.kind !== 'all'}
              <h2 class="section-label">
                {#if g.kind === 'pinned'}<span class="material-symbols-rounded fill">keep</span>{/if}
                {#if g.kind === 'label' || g.kind === 'color'}<span class="group-dot" style="background:{g.kind === 'label' ? colorDot(g.label.color) : colorDot(g.color)}"></span>{/if}
                {groupTitle(g)}
                <span class="group-count">{g.notes.length}</span>
              </h2>
            {/if}
            {#each g.notes as n (g.key + ':' + n.id)}
              <NoteRow note={n} {terms} selected={selectedIds.has(n.id)} {selecting} on:open={openNote} on:select={onSelect} />
            {/each}
          </section>
        {/each}
        {#if moreToShow}<div class="more-marker" use:growOnScroll={{ onGrow: showMore }} aria-hidden="true"></div>{/if}
      </div>
    {:else if timeline}
      {#if pinned.length}
        <section class="notes-section timeline">
          <h2 class="section-label"><span class="material-symbols-rounded fill">keep</span>{$_('notes.pinned')}</h2>
          <div class="timeline-list">
            {#each pinned as n (n.id)}<NoteCard note={n} {view} {terms} selected={selectedIds.has(n.id)} {selecting} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} on:select={onSelect} />{/each}
          </div>
        </section>
      {/if}
      {#each groupByDay(othersShown) as day (day.key)}
        <section class="notes-section timeline">
          <h2 class="section-label"><span class="material-symbols-rounded">calendar_today</span>{dayLabel(day)}</h2>
          <div class="timeline-list">
            {#each day.notes as n (n.id)}<NoteCard note={n} {view} {terms} selected={selectedIds.has(n.id)} {selecting} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} on:select={onSelect} />{/each}
          </div>
        </section>
      {/each}
      {#if moreToShow}<div class="more-marker" use:growOnScroll={{ onGrow: showMore }} aria-hidden="true"></div>{/if}
    {:else}
      {#if pinned.length}
        <section class="notes-section">
          <h2 class="section-label"><span class="material-symbols-rounded fill">keep</span>{$_('notes.pinned')}</h2>
          <NoteGrid notes={pinned} {view} {terms} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} on:select={onSelect} selectedIds={selectedIds} {selecting} draggable={orderable && !selectedIds.size} on:reorder={onReorder} {swipeable} on:swipe={onSwipe} />
        </section>
      {/if}
      {#if others.length}
        <section class="notes-section">
          {#if pinned.length}<h2 class="section-label">{$_('notes.others')}</h2>{/if}
          {#if view === 'reminders' && pastReminders.length}<h2 class="section-label">{$_('reminders.upcoming')}</h2>{/if}
          <NoteGrid notes={othersShown} {view} {terms} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} on:select={onSelect} selectedIds={selectedIds} {selecting} draggable={orderable && !selectedIds.size} on:reorder={onReorder} {swipeable} on:swipe={onSwipe} />
        </section>
      {/if}
      {#if moreToShow}<div class="more-marker" use:growOnScroll={{ onGrow: showMore }} aria-hidden="true"></div>{/if}
      {#if view === 'reminders' && pastReminders.length}
        <section class="notes-section">
          <h2 class="section-label">{$_('reminders.past')}</h2>
          <NoteGrid notes={pastReminders} {view} {terms} on:open={openNote} on:action={onCardAction} on:toggleItem={onToggleItem} on:menu={onMenu} on:select={onSelect} selectedIds={selectedIds} {selecting} draggable={orderable && !selectedIds.size} on:reorder={onReorder} {swipeable} on:swipe={onSwipe} />
        </section>
      {/if}
    {/if}
  </div>

  {#if canCapture}
    <!-- On body: the page wrapper has will-change, which would otherwise hold a
         fixed button inside the scroll and carry it away with the notes. -->
    <button class="fab" use:portal class:hidden-fab={selecting || fabMenu} on:click={onFabClick} on:pointerdown={() => fabHeld = false} aria-label={$_('notes.new_note')}
      aria-haspopup="menu" aria-expanded={fabMenu}
      title={canRecordVoice ? $_('notes.hold_for_voice') : undefined}
      use:longpress on:longpress={() => { if (canRecordVoice) { fabHeld = true; navigator.vibrate?.(20); newVoiceNote(); } }}>
      <span class="material-symbols-rounded">add</span>
    </button>
  {/if}
</div>

{#if fabMenu}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="fab-scrim" use:portal on:click={() => fabMenu = false} transition:fade={{ duration: 150 }}></div>
  <div class="fab-menu" use:portal role="menu" tabindex="-1" aria-label={$_('notes.new_note')}
    on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); fabMenu = false; } }}>
    {#each [
      ['image', 'add_photo_alternate', 'notes.menu_image', () => captureImageInput.click()],
      ...(canRecordVoice ? [['voice', 'mic', 'notes.menu_voice', newVoiceNote]] : []),
      ['list', 'checklist', 'notes.menu_list', () => newNote('checklist')],
      ['text', 'edit_note', 'notes.menu_text', () => newNote('text')],
    ] as [key, icon, label, action], i (key)}
      <button class="fab-item" role="menuitem" on:click={() => fromFabMenu(action)}
        in:fly|global={{ y: 12, duration: 180, delay: (3 - i) * 30 }} out:fade|global={{ duration: 100 }}>
        <span class="fab-item-label">{$_(label)}</span>
        <span class="material-symbols-rounded fab-item-icon">{icon}</span>
      </button>
    {/each}
    <!-- svelte-ignore a11y-autofocus -->
    <button class="fab fab-close" on:click={() => fabMenu = false} aria-label={$_('common.close')} autofocus>
      <span class="material-symbols-rounded">close</span>
    </button>
  </div>
{/if}

{#if editing}
  <!-- Keyed per open: reopening while the last editor is still fading out
       would otherwise resume that editor with the previous note's state. -->
  {#key editing}
    <NoteEditor bind:this={overlayRef} autoRecord={!!editing.voice} note={editing.note || null} initialKind={editing.kind || 'text'} initialLabels={editing.labels || []}
      prefill={editing.prefill || null} originId={editing.originId ?? null} on:close={closeEditor} />
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
  <!-- On body for the same reason as the + button: the page wrapper would
       otherwise carry it away with the notes. -->
  <div class="bulk-bar" use:portal role="toolbar" aria-label={$_('select.toolbar')} transition:fly={{ y: 24, duration: 220 }}>
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
<Popover bind:open={viewOpen} anchor={viewAnchor}>
  <div class="view-menu" role="menu">
    <p class="vm-title">{$_('list.layout')}</p>
    {#each [['grid', 'grid_view', 'timeline.show_grid', 'list.grid_desc'], ['list', 'view_list', 'timeline.show_list', 'list.list_desc'], ['timeline', 'view_timeline', 'timeline.show_timeline', 'list.timeline_desc']] as [value, icon, label, desc]}
      <button class="vm-row" role="menuitemradio" aria-checked={layout === value} class:on={layout === value}
        on:click={() => { setLayout(value); if (value !== 'list') viewOpen = false; }}>
        <span class="material-symbols-rounded">{icon}</span>
        <span class="vm-text"><strong>{$_(label)}</strong><small>{$_(desc)}</small></span>
        {#if layout === value}<span class="material-symbols-rounded vm-check">check</span>{/if}
      </button>
    {/each}
    {#if listMode}
      <p class="vm-title">{$_('list.group_by')}</p>
      <div class="vm-chips">
        {#each [['none', 'list.group_none'], ['label', 'list.group_label'], ['color', 'list.group_color'], ['date', 'list.group_date']] as [value, label]}
          <button class="fchip" class:on={$listGroupBy === value} aria-pressed={$listGroupBy === value} on:click={() => listGroupBy.set(value)}>{$_(label)}</button>
        {/each}
      </div>
    {/if}
  </div>
</Popover>
<Popover bind:open={newOpen} anchor={newAnchor}>
  <div class="view-menu new-menu" role="menu">
    <button class="vm-row" role="menuitem" on:click={() => { newOpen = false; newNote('text'); }}>
      <span class="material-symbols-rounded">edit_note</span><span class="vm-text"><strong>{$_('notes.new_note')}</strong></span>
    </button>
    <button class="vm-row" role="menuitem" on:click={() => { newOpen = false; newNote('checklist'); }}>
      <span class="material-symbols-rounded">checklist</span><span class="vm-text"><strong>{$_('notes.new_checklist')}</strong></span>
    </button>
    {#if canRecordVoice}
      <button class="vm-row" role="menuitem" on:click={() => { newOpen = false; newVoiceNote(); }}>
        <span class="material-symbols-rounded">mic</span><span class="vm-text"><strong>{$_('notes.new_voice_note')}</strong></span>
      </button>
    {/if}
    <button class="vm-row" role="menuitem" on:click={() => { newOpen = false; captureImageInput.click(); }}>
      <span class="material-symbols-rounded">add_photo_alternate</span><span class="vm-text"><strong>{$_('notes.new_with_image')}</strong></span>
    </button>
  </div>
</Popover>
<ActionSheet bind:open={menuOpen} title={menuNote?.title || ''} actions={menuActions} on:select={onMenuSelect} />

<style>
  /* Search in the banner */
  .notes-header .header-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .notes-header .header-btn { border-radius: 12px; color: var(--text-2); display: flex; align-items: center; justify-content: center; transition: background var(--dur-fast), color var(--dur-fast); }
  .notes-header .header-btn:hover { background: color-mix(in srgb, var(--text-1) 10%, transparent); color: var(--text-1); }
  .notes-header.banner-gradient .header-btn, .notes-header.banner-animated .header-btn { color: rgba(255, 255, 255, 0.92); }
  .notes-header.banner-gradient .header-btn:hover, .notes-header.banner-animated .header-btn:hover { background: rgba(255, 255, 255, 0.16); color: #fff; }
  .header-search {
    flex: 1; min-width: 0; height: 40px;
    display: flex; align-items: center; gap: 8px; padding: 0 0 0 12px;
    border-radius: 12px;
    background: var(--surface-2); border: 1px solid var(--border-strong);
    color: var(--text-3);
    max-width: 720px; margin: 0 auto;
  }
  .header-search input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--text-1); font-size: 15px; }
  .header-search input::-webkit-search-cancel-button { display: none; }
  .notes-header.banner-gradient .header-search, .notes-header.banner-animated .header-search {
    background: rgba(255, 255, 255, 0.16); border-color: rgba(255, 255, 255, 0.28); color: rgba(255, 255, 255, 0.85);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
  }
  .notes-header.banner-gradient .header-search input, .notes-header.banner-animated .header-search input { color: #fff; }
  .notes-header.banner-gradient .header-search input::placeholder, .notes-header.banner-animated .header-search input::placeholder { color: rgba(255, 255, 255, 0.72); }
  .notes-header.banner-gradient .search-kbd, .notes-header.banner-animated .search-kbd { border-color: rgba(255, 255, 255, 0.3); color: rgba(255, 255, 255, 0.8); }

  .view-menu { display: flex; flex-direction: column; gap: 2px; width: 280px; max-width: 100%; }
  :global(.pop-panel.sheet) .view-menu { width: 100%; }
  .vm-title { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); padding: 6px 8px 4px; }
  .vm-row { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 6px 10px; border-radius: 12px; text-align: left; color: var(--text-1); }
  .vm-row:hover { background: color-mix(in srgb, var(--text-1) 7%, transparent); }
  .vm-row.on { background: var(--accent-dim); }
  .vm-row > .material-symbols-rounded { font-size: 22px; color: var(--text-2); }
  .vm-row.on > .material-symbols-rounded { color: var(--accent); }
  .vm-text { flex: 1; display: flex; flex-direction: column; }
  .vm-text strong { font-size: 14px; font-weight: 600; }
  .vm-text small { font-size: 12px; color: var(--text-3); }
  .vm-check { color: var(--accent) !important; font-size: 20px !important; }
  .vm-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 8px 8px; }

  .bulk-bar {
    position: fixed; z-index: 150;
    bottom: calc(var(--tabbar-h, 0px) + var(--safe-bottom) + 16px);
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
    .bulk-bar { left: 8px; right: 8px; bottom: calc(var(--tabbar-h, var(--nav-h)) + var(--safe-bottom) + 10px); padding: 0 4px; }
    .bulk-bar { gap: 0; }
    .bulk-btn { width: 36px; }
    .bulk-count { font-size: 14px; padding: 0 2px; }
    .bulk-divider { margin: 0 2px; }
  }


  /* List layout on a phone or a medium screen: one rounded column of rows. */
  .list-card {
    width: 100%; max-width: 760px; margin: 0 auto;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .list-section { display: flex; flex-direction: column; }
  .list-col .section-label {
    position: sticky; top: 0; z-index: 2;
    padding: 12px 18px 6px; margin: 0;
    background: var(--list-bg, var(--surface-1));
  }
  .list-card .section-label { position: static; background: none; }
  .list-card .list-section + .list-section { border-top: 1px solid var(--border); }
  .group-dot { width: 8px; height: 8px; border-radius: 50%; }
  .group-count { font-weight: 500; opacity: 0.7; }

  /* Wide screens: list column and reading pane fill the screen under the banner. */
  .notes-page.workspace-page { padding-bottom: 0; min-height: 0; }
  .notes-body.workspace-body { padding: 0; gap: 0; max-width: none; }
  .workspace-body .trash-note { padding: 10px 16px; border-bottom: 1px solid var(--border); }
  .workspace {
    display: grid; grid-template-columns: var(--list-w) var(--hinge, 0px) minmax(0, 1fr);
    min-height: 0; overflow: hidden;
  }
  .workspace.resizing { user-select: none; cursor: col-resize; }
  .list-col {
    display: flex; flex-direction: column; min-height: 0;
    --list-bg: color-mix(in srgb, var(--surface-1) 60%, var(--bg));
    background: var(--list-bg);
    border-right: 1px solid var(--border);
  }
  .list-head {
    display: flex; align-items: center; gap: 10px; flex-shrink: 0;
    height: 58px; padding: 0 12px 0 18px;
    border-bottom: 1px solid var(--border);
  }
  .list-count { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .new-split {
    display: flex; align-items: stretch; height: 36px; flex-shrink: 0;
    border-radius: 11px; overflow: hidden;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    box-shadow: 0 4px 14px -6px color-mix(in srgb, var(--accent) 70%, transparent);
  }
  .new-split button { color: var(--accent-text); display: flex; align-items: center; transition: background var(--dur-fast); }
  .new-split button:hover { background: rgba(255, 255, 255, 0.14); }
  .new-main { gap: 4px; padding: 0 12px 0 8px; font-size: 13.5px; font-weight: 600; }
  .new-main .material-symbols-rounded { font-size: 20px; }
  .new-more { width: 30px; justify-content: center; border-left: 1px solid rgba(0, 0, 0, 0.14); }
  .new-more .material-symbols-rounded { font-size: 20px; }
  .list-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 24px; }
  .list-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; padding: 48px 24px; color: var(--text-3); }
  .list-empty .material-symbols-rounded { font-size: 36px; color: var(--accent); opacity: 0.8; margin-bottom: 4px; }
  .list-empty strong { color: var(--text-1); font-family: var(--font-note-title); font-weight: 500; font-size: 18px; }
  .list-empty p { font-size: 13px; line-height: 1.5; }
  .list-resizer {
    position: relative; z-index: 3; width: var(--hinge, 0px); cursor: col-resize; outline: none;
  }
  /* Snapped to the fold: the fold is the divider. */
  .workspace.fold-snap .list-resizer { pointer-events: none; }
  .workspace.fold-snap .list-resizer::after { display: none; }
  .list-resizer::before { content: ''; position: absolute; top: 0; bottom: 0; left: -5px; width: 10px; }
  .list-resizer::after {
    content: ''; position: absolute; top: 0; bottom: 0; left: -1px; width: 2px;
    background: var(--accent); opacity: 0; transition: opacity var(--dur-fast);
  }
  .list-resizer:hover::after, .list-resizer:focus-visible::after, .workspace.resizing .list-resizer::after { opacity: 0.7; }
  .pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .pane-empty {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
    color: var(--text-3); text-align: center; padding: 24px;
  }
  .pane-empty > .material-symbols-rounded { font-size: 44px; color: var(--accent); opacity: 0.7; }
  .pane-empty p { font-size: 14px; }
  .pane-empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 4px; }
  .pane-empty .btn .material-symbols-rounded { font-size: 18px; }
  .timeline-list { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 720px; margin: 0 auto; }
  .notes-section.timeline { width: 100%; }
  .notes-section.timeline .section-label { max-width: 720px; margin-left: auto; margin-right: auto; }

  .notes-page { --notes-max: 1680px; }
  .empty-trash { height: 38px; }

  .recent-bar {
    display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 6px;
    max-width: min(var(--notes-max), 980px); margin: 10px auto 0; width: 100%;
    padding: 0 var(--page-px);
  }
  .recent-label { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); margin-right: 2px; }
  .recent-bar .fchip .material-symbols-rounded { font-size: 15px; color: var(--text-3); }
  @media (max-width: 600px) {
    .recent-bar { flex-wrap: nowrap; justify-content: flex-start; overflow-x: auto; scrollbar-width: none; }
    .recent-bar::-webkit-scrollbar { display: none; }
    .recent-bar .fchip { flex-shrink: 0; }
  }
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

  .trash-note { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px 14px; text-align: center; font-size: 13px; color: var(--text-3); }

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
    bottom: calc(var(--tabbar-h, var(--nav-h)) + var(--safe-bottom) + 16px);
    width: 60px; height: 60px;
    border-radius: 20px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: var(--accent-text);
    box-shadow: var(--shadow-lg);
    display: none; align-items: center; justify-content: center;
    z-index: 40;   /* over the notes, under the bottom bar at 50 */
  }
  .fab .material-symbols-rounded { font-size: 30px; }
  .fab.hidden-fab { visibility: hidden; }
  /* The + menu sits above everything, Trace's button included. */
  :global(.fab-scrim) {
    position: fixed; inset: 0; z-index: 430;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  }
  :global(.fab-menu) {
    position: fixed; z-index: 431;
    right: 16px; bottom: calc(var(--tabbar-h, var(--nav-h)) + var(--safe-bottom) + 16px);
    display: flex; flex-direction: column; align-items: flex-end; gap: 12px;
  }
  :global(.fab-menu .fab-item) {
    display: flex; align-items: center; gap: 12px; padding: 0 0 0 4px;
    color: var(--text-1); font-size: 15px; font-weight: 600;
  }
  :global(.fab-menu .fab-item-label) {
    padding: 8px 14px; border-radius: 12px;
    background: var(--surface-2); border: 1px solid var(--border-strong); box-shadow: var(--shadow-md);
  }
  :global(.fab-menu .fab-item-icon) {
    width: 52px; height: 52px; margin-right: 4px; border-radius: 16px;
    display: flex; align-items: center; justify-content: center; font-size: 25px;
    background: var(--accent-dim); color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); box-shadow: var(--shadow-md);
  }
  :global(.fab-menu .fab-close) {
    position: static; display: flex; width: 60px; height: 60px; border-radius: 20px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: var(--accent-text); box-shadow: var(--shadow-lg);
  }
  :global(.fab-menu .fab-close .material-symbols-rounded) { font-size: 28px; }
  /* Same as PHONE_CAPTURE in the script: phones in either orientation. */
  @media (max-width: 600px), (pointer: coarse) and (max-height: 500px) {
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
