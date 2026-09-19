<script>
  /**
   * Tasks: open checklist items that have a due date, plus everything on
   * checklists shown in Tasks (or every checklist, with that setting on).
   *
   * Nothing new is stored: a task is a checklist item, so every change here
   * is a change to its note (and syncs the same way). Group by due date
   * (Overdue, Today, Tomorrow, This Week, Later, No Due Date) or by list.
   *
   * A task can be ticked (or swiped right), edited in place, dated and set to
   * repeat, moved to another list, or deleted (swiped left), each with Undo.
   * Ticked tasks from the last week wait in Completed. By List, each list has
   * its own add row and its tasks can be dragged into order.
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import { fly, slide } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { dragHandleZone, dragHandle } from 'svelte-dnd-action';
  import { _ } from 'svelte-i18n';
  import { bannerStyle, tasksGroupBy, tasksAllChecklists, keyboardShortcuts } from '../stores/settings.js';
  import { isTask, isTasksInbox, itemAfterPatch } from '../../server/lib/task-rules.js';
  import { NoteApi } from '../lib/api.js';
  import { notesChanged, signalCountsChanged } from '../stores/notes.js';
  import { showError, showUndo } from '../stores/toast.js';
  import { canEdit } from '../lib/note-sharing.js';
  import { colorDot } from '../lib/note-colors.js';
  import { groupByDue, dueLabel, dueStatus, todayStr } from '../lib/due-dates.js';
  import { rowSwipe } from '../lib/row-swipe.js';
  import Popover from '../components/notes/Popover.svelte';
  import DuePicker from '../components/notes/DuePicker.svelte';
  import NoteEditor from '../components/notes/NoteEditor.svelte';

  const FLIP_MS = 200;
  const COMPLETED_DAYS = 7;

  let notes = [];
  let loading = true;
  let editing = null;
  let loadSeq = 0;

  async function load() {
    const seq = ++loadSeq;
    try {
      // Only checklists: a big library's text notes are no business of this screen.
      const rows = await NoteApi.getNotes({ view: 'notes', kind: 'checklist' });
      if (seq === loadSeq) notes = (rows || []).filter(n => n.kind === 'checklist');
    } catch (e) {
      if (seq === loadSeq) showError(e.message);
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }
  $: $notesChanged, load();

  /** Put a note the server sent back in place (or add it: a new Tasks list). */
  function putNote(n) {
    if (!n || n.kind !== 'checklist') return;
    notes = notes.some(x => x.id === n.id) ? notes.map(x => x.id === n.id ? n : x) : [n, ...notes];
  }

  const newUuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const tsMs = (s) => Date.parse(String(s || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s || '')) ? '' : 'Z'));

  // Items being ticked stay on screen for a moment, struck through.
  let leaving = new Set();
  $: inboxTitle = $_('tasks.inbox_title');
  // A task: an open item with a due date, or on a checklist shown in Tasks (see task-rules.js).
  $: tasks = notes.flatMap(n => (n.items || [])
    .filter(i => leaving.has(i.uuid) ? String(i.text || '').trim() : isTask(n, i, { allChecklists: $tasksAllChecklists || isTasksInbox(n, inboxTitle) }))
    .map(i => ({ ...i, id: i.uuid, key: i.uuid, note: n, editable: canEdit(n) })));
  // Lists that belong in Tasks keep their place By List even when there's nothing open on them.
  $: taskLists = notes.filter(n => n.in_tasks || isTasksInbox(n, inboxTitle) || tasks.some(t => t.note.id === n.id));
  $: groups = $tasksGroupBy === 'note'
    ? taskLists.map(n => ({ key: `n${n.id}`, note: n, items: tasks.filter(t => t.note.id === n.id) }))
    : groupByDue(tasks);
  $: completed = notes.flatMap(n => (n.items || [])
      .filter(i => i.checked && !leaving.has(i.uuid) && i.checked_at && Date.now() - tsMs(i.checked_at) < COMPLETED_DAYS * 864e5
        && (i.due_date || n.in_tasks || $tasksAllChecklists || isTasksInbox(n, inboxTitle)))
      .map(i => ({ ...i, key: `c${i.uuid}`, note: n, editable: canEdit(n) })))
    .sort((a, b) => tsMs(b.checked_at) - tsMs(a.checked_at))
    .slice(0, 50);
  let showCompleted = false;
  // Lists a task can be added or moved to: the ones already in Tasks, then the rest.
  $: writableLists = notes.filter(n => canEdit(n))
    .sort((a, b) => Number(isTasksInbox(b, inboxTitle)) - Number(isTasksInbox(a, inboxTitle)) || String(a.title || '').localeCompare(String(b.title || '')));
  $: listsInTasks = writableLists.filter(n => $tasksAllChecklists || n.in_tasks || isTasksInbox(n, inboxTitle));
  $: otherLists = writableLists.filter(n => !($tasksAllChecklists || n.in_tasks || isTasksInbox(n, inboxTitle)));

  /**
   * An undated task on a list that isn't in Tasks wouldn't show here, so it
   * would seem to vanish the moment it's added or moved. Choosing such a list
   * from Tasks shows that list in Tasks too. Returns true when it did.
   */
  async function keepInTasks(target, dueDate) {
    if (dueDate || $tasksAllChecklists || target.in_tasks || isTasksInbox(target, inboxTitle)) return false;
    putNote(await NoteApi.updateNote(target.id, { in_tasks: true }));
    return true;
  }

  function groupTitle(g) {
    if (g.note) return g.note.title || $_('notes.untitled');
    return $_(`tasks.group_${g.key}`);
  }

  /** Change an item: straight away on screen, then on the server, keeping what it sends back. */
  async function patchTask(task, patch) {
    const today = todayStr();
    notes = notes.map(n => n.id !== task.note.id ? n : { ...n, items: n.items.map(i => i.uuid === task.uuid ? itemAfterPatch(i, patch, today) : i) });
    try {
      putNote(await NoteApi.updateItem(task.note.id, task.uuid, { ...patch, today }));
      if ('checked' in patch || 'due_date' in patch || 'due_repeat' in patch) signalCountsChanged();
    } catch (e) {
      showError(e.message);
      load();
    }
  }

  async function toggle(task) {
    if (!task.editable) return;
    const checking = !task.checked;
    const after = itemAfterPatch(task, { checked: checking }, todayStr());
    const moved = checking && !after.checked;
    if (checking && !moved) {
      leaving = new Set([...leaving, task.uuid]);
      setTimeout(() => { leaving.delete(task.uuid); leaving = new Set(leaving); }, 700);
    }
    await patchTask(task, { checked: checking });
    if (moved) {
      // A repeating task moves on: say where to, and let the date be put back.
      showUndo($_('tasks.next_due', { values: { date: dueLabel(after.due_date, $_) } }),
        () => patchTask({ ...task, checked: false }, { due_date: task.due_date }), $_('common.undo'));
    } else if (checking) {
      showUndo($_('tasks.done', { values: { text: task.text.slice(0, 40) } }),
        () => patchTask({ ...task, checked: true }, { checked: false }), $_('common.undo'));
    }
  }

  // ── Edit in place ──────────────────────────────────────────────────
  let editUuid = null;
  let draft = '';
  let editInput;
  async function startEdit(task) {
    if (!task.editable) return;
    editUuid = task.uuid;
    draft = task.text;
    await tick();
    editInput?.focus();
    editInput?.select();
  }
  function commitEdit(task) {
    if (editUuid !== task.uuid) return;
    editUuid = null;
    const text = draft.trim();
    if (text === task.text) return;
    if (!text) { removeTask(task); return; }
    patchTask(task, { text });
  }
  function onEditKey(e, task) {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(task); focusRow(task.key); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editUuid = null; focusRow(task.key); }
  }

  // ── Delete and move ────────────────────────────────────────────────
  async function removeTask(task) {
    if (!task.editable) return;
    try {
      putNote(await NoteApi.deleteItem(task.note.id, task.uuid));
      signalCountsChanged();
      showUndo($_('tasks.deleted', { values: { text: task.text.slice(0, 40) } }), async () => {
        putNote(await NoteApi.addItem(task.note.id, {
          uuid: task.uuid, text: task.text, position: task.position, due_date: task.due_date, due_repeat: task.due_repeat,
        }));
        signalCountsChanged();
      }, $_('common.undo'));
    } catch (e) {
      showError(e.message);
      load();
    }
  }

  async function moveTask(task, target) {
    if (!task.editable || !target || target.id === task.note.id) return;
    const uuid = newUuid();
    try {
      // Added before it's removed, so a failure in between leaves a copy rather than nothing.
      putNote(await NoteApi.addItem(target.id, { uuid, text: task.text, due_date: task.due_date, due_repeat: task.due_repeat }));
      putNote(await NoteApi.deleteItem(task.note.id, task.uuid));
      const shown = await keepInTasks(target, task.due_date);
      const list = target.title || $_('notes.untitled');
      showUndo($_(shown ? 'tasks.moved_shown' : 'tasks.moved', { values: { list } }), async () => {
        putNote(await NoteApi.addItem(task.note.id, {
          uuid: task.uuid, text: task.text, position: task.position, due_date: task.due_date, due_repeat: task.due_repeat,
        }));
        putNote(await NoteApi.deleteItem(target.id, uuid));
        if (shown) putNote(await NoteApi.updateNote(target.id, { in_tasks: false }));
      }, $_('common.undo'));
    } catch (e) {
      showError(e.message);
      load();
    }
  }

  // ── Menu ───────────────────────────────────────────────────────────
  let menuFor = null, menuAnchor = null, menuOpen = false, menuMode = 'actions';
  function openMenu(e, task) {
    if (!task.editable) return;
    menuFor = task;
    menuMode = 'actions';
    menuAnchor = e?.currentTarget?.getBoundingClientRect?.() || rowAnchor(task.key);
    menuOpen = true;
  }
  function menuAction(action) {
    const task = menuFor;
    if (!task) return;
    if (action === 'move') { menuMode = 'move'; return; }
    menuOpen = false;
    if (action === 'edit') startEdit(task);
    else if (action === 'due') openDue(null, task);
    else if (action === 'open') openNote(task.note);
    else if (action === 'delete') removeTask(task);
  }

  // ── Due date and repeat ────────────────────────────────────────────
  let dueFor = null, dueAnchor = null, dueOpen = false;
  function openDue(e, task) {
    if (!task.editable) return;
    dueFor = task;
    dueAnchor = e?.currentTarget?.getBoundingClientRect?.() || rowAnchor(task.key);
    dueOpen = true;
  }
  function setDue(value) {
    dueOpen = false;
    const task = dueFor;
    if (!task) return;
    patchTask(task, value ? { due_date: value } : { due_date: null, due_repeat: null });
  }
  function setRepeat(repeat) {
    const task = dueFor;
    if (!task) return;
    const due = task.due_date || (repeat ? todayStr() : null);
    dueFor = { ...task, due_date: due, due_repeat: repeat };
    patchTask(task, { due_date: due, due_repeat: repeat });
  }

  // ── Adding ─────────────────────────────────────────────────────────
  let newText = '';
  let newDue = null;
  let newRepeat = null;
  let adding = false;
  let quickListId = null;           // null: the Tasks list
  let quickInput;
  let quickDueAnchor = null, quickDueOpen = false;
  let listPickAnchor = null, listPickOpen = false;
  $: quickList = writableLists.find(n => n.id === quickListId) || null;

  /** The Tasks list, made the first time something is added to it. */
  async function ensureInbox() {
    let inbox = notes.find(n => isTasksInbox(n, inboxTitle) && n.share_role !== 'view' && n.share_role !== 'edit');
    if (!inbox) {
      inbox = await NoteApi.createNote({ title: inboxTitle, kind: 'checklist', items: [], in_tasks: true });
      putNote(inbox);
    } else if (!inbox.in_tasks) {
      putNote(await NoteApi.updateNote(inbox.id, { in_tasks: true }));
    }
    return inbox;
  }

  async function add() {
    const text = newText.trim();
    if (!text || adding) return;
    adding = true;
    try {
      const target = quickList || await ensureInbox();
      putNote(await NoteApi.addItem(target.id, { uuid: newUuid(), text, due_date: newDue, due_repeat: newDue ? newRepeat : null }));
      if (await keepInTasks(target, newDue)) {
        showUndo($_('tasks.added_shown', { values: { list: target.title || $_('notes.untitled') } }),
          async () => putNote(await NoteApi.updateNote(target.id, { in_tasks: false })), $_('tasks.hide_list'));
      }
      if (newDue) signalCountsChanged();
      newText = '';
      newDue = null;
      newRepeat = null;
    } catch (e) {
      showError(e.message);
    } finally {
      adding = false;
      quickInput?.focus();
    }
  }

  // By List: an add row under each list.
  let listDrafts = {};
  async function addToList(note) {
    const text = String(listDrafts[note.id] || '').trim();
    if (!text) return;
    listDrafts = { ...listDrafts, [note.id]: '' };
    try {
      putNote(await NoteApi.addItem(note.id, { uuid: newUuid(), text }));
    } catch (e) {
      listDrafts = { ...listDrafts, [note.id]: text };
      showError(e.message);
    }
  }

  // ── Drag to reorder (By List) ──────────────────────────────────────
  let dragItems = {};               // group key -> items while a drag is under way
  function onConsider(g, e) { dragItems = { ...dragItems, [g.key]: e.detail.items }; }
  async function onFinalize(g, e) {
    const order = e.detail.items.map(t => t.uuid);
    dragItems = { ...dragItems, [g.key]: e.detail.items };
    // Only open tasks were dragged: they swap among the places they held, and
    // everything else on the list (ticked items, non-tasks) stays put.
    const all = [...(g.note.items || [])].sort((a, b) => a.position - b.position).map(i => i.uuid);
    const moved = new Set(order);
    const merged = all.slice();
    let k = 0;
    all.forEach((u, idx) => { if (moved.has(u)) merged[idx] = order[k++]; });
    try {
      putNote(await NoteApi.reorderItems(g.note.id, merged));
    } catch (err) {
      showError(err.message);
      load();
    } finally {
      const { [g.key]: _done, ...rest } = dragItems;
      dragItems = rest;
    }
  }

  // ── Open a list ────────────────────────────────────────────────────
  function openNote(note) { editing = { note, originId: null }; }
  async function closeEditor(e) {
    const target = e?.detail?.navigate;
    editing = null;
    load();
    if (target) {
      await tick();
      try { const n = await NoteApi.getNote(target); if (n) editing = { note: n }; } catch { /* gone */ }
    }
  }

  // ── Keyboard ───────────────────────────────────────────────────────
  let listEl;
  const rowEls = () => [...(listEl?.querySelectorAll('.task[data-task-key]') || [])];
  function focusRow(key) { tick().then(() => listEl?.querySelector(`.task[data-task-key="${CSS.escape(key)}"]`)?.focus()); }
  function rowAnchor(key) { return listEl?.querySelector(`.task[data-task-key="${CSS.escape(key)}"]`)?.getBoundingClientRect() || null; }
  function focusedTask() {
    const key = document.activeElement?.closest?.('.task[data-task-key]')?.dataset.taskKey;
    return key ? tasks.find(t => t.key === key) || null : null;
  }
  function onKey(e) {
    if (!$keyboardShortcuts || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (editing || menuOpen || dueOpen || quickDueOpen || listPickOpen) return;
    if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (document.querySelector('[role="dialog"][aria-modal="true"], .pop-backdrop')) return;
    const rows = rowEls();
    const cur = rows.indexOf(document.activeElement?.closest?.('.task[data-task-key]'));
    const task = focusedTask();
    const move = (step) => {
      if (!rows.length) return;
      const next = rows[cur < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, cur + step))];
      next.focus();
      next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    switch (e.key) {
      case 'j': case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'k': case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'n': case 'c': e.preventDefault(); quickInput?.focus(); break;
      case 'x': case ' ': if (task) { e.preventDefault(); toggle(task); } break;
      case 'e': case 'Enter': if (task) { e.preventDefault(); startEdit(task); } break;
      case 'd': if (task) { e.preventDefault(); openDue(null, task); } break;
      case 'm': if (task) { e.preventDefault(); menuFor = task; menuMode = 'move'; menuAnchor = rowAnchor(task.key); menuOpen = true; } break;
      case 'o': if (task) { e.preventDefault(); openNote(task.note); } break;
      case '#': case 'Delete': if (task) { e.preventDefault(); const next = rows[cur + 1] || rows[cur - 1]; removeTask(task); if (next) tick().then(() => next.focus()); } break;
    }
  }
  onMount(() => { load(); window.addEventListener('keydown', onKey); });
  onDestroy(() => window.removeEventListener('keydown', onKey));

  const touch = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
</script>

<div class="page-shell tasks-page">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('nav.tasks')}</h1>
  </header>

  <div class="tasks-body" bind:this={listEl}>
    <div class="tasks-toolbar">
      <form class="quick-add" on:submit|preventDefault={add}>
        <span class="material-symbols-rounded">add_task</span>
        <input bind:this={quickInput} bind:value={newText} placeholder={$_('tasks.add_placeholder')} aria-label={$_('tasks.add_placeholder')} maxlength="5000" />
        <button type="button" class="qa-chip" class:set={!!quickList}
          on:click={(e) => { listPickAnchor = e.currentTarget.getBoundingClientRect(); listPickOpen = true; }}
          title={$_('tasks.add_to_list')} aria-label={`${$_('tasks.add_to_list')}: ${quickList ? (quickList.title || $_('notes.untitled')) : inboxTitle}`}>
          <span class="material-symbols-rounded">checklist</span><span class="qa-chip-text">{quickList ? (quickList.title || $_('notes.untitled')) : inboxTitle}</span>
        </button>
        <button type="button" class="qa-chip" class:set={!!newDue} on:click={(e) => { quickDueAnchor = e.currentTarget.getBoundingClientRect(); quickDueOpen = true; }}
          title={$_('due.title')} aria-label={$_('due.title')}>
          <span class="material-symbols-rounded">{newRepeat ? 'event_repeat' : 'event'}</span>{#if newDue}<span class="qa-chip-text">{dueLabel(newDue, $_)}</span>{/if}
        </button>
        <button class="btn btn-primary qa-go" type="submit" disabled={!newText.trim() || adding}>{$_('tasks.add')}</button>
      </form>
      <div class="group-toggle" role="radiogroup" aria-label={$_('tasks.group_by')}>
        <button role="radio" aria-checked={$tasksGroupBy !== 'note'} class:on={$tasksGroupBy !== 'note'} on:click={() => tasksGroupBy.set('due')}>
          <span class="material-symbols-rounded">event</span>{$_('tasks.by_due')}
        </button>
        <button role="radio" aria-checked={$tasksGroupBy === 'note'} class:on={$tasksGroupBy === 'note'} on:click={() => tasksGroupBy.set('note')}>
          <span class="material-symbols-rounded">checklist</span>{$_('tasks.by_note')}
        </button>
      </div>
    </div>

    {#if loading}
      <div class="task-skeleton" aria-hidden="true">{#each Array(5) as _s}<div></div>{/each}</div>
    {:else}
      {#if !groups.length}
        <div class="empty">
          <span class="material-symbols-rounded empty-icon">task_alt</span>
          <h2>{$_('tasks.empty_title')}</h2>
          <p>{$_('tasks.empty_body')}</p>
        </div>
      {/if}
      {#each groups as g (g.key)}
        {@const byList = !!g.note}
        {@const shown = dragItems[g.key] || g.items}
        <section class="task-group" class:overdue={g.key === 'overdue'} transition:slide={{ duration: 180 }}>
          <h2 class="group-title">
            {#if byList}
              <button class="group-note" on:click={() => openNote(g.note)}>
                <span class="dot" style="background:{colorDot(g.note.color)}"></span>{groupTitle(g)}
                <span class="material-symbols-rounded">open_in_new</span>
              </button>
            {:else}
              {groupTitle(g)}
            {/if}
            <span class="count">{g.items.length}</span>
          </h2>
          <ul class="task-list"
            use:dragHandleZone={{ items: shown, flipDurationMs: FLIP_MS, dropTargetStyle: {}, type: `tasks-${g.key}`, dragDisabled: !byList || !canEdit(g.note || {}) }}
            on:consider={(e) => onConsider(g, e)} on:finalize={(e) => onFinalize(g, e)}>
            {#each shown as task (task.id)}
              <li class="task" class:done={task.checked} class:editing={editUuid === task.uuid} data-task-key={task.key} tabindex="-1"
                animate:flip={{ duration: FLIP_MS }} out:fly={{ x: 24, duration: 200 }}
                use:rowSwipe={{ enabled: touch && task.editable && editUuid !== task.uuid, onSwipe: (dir) => dir === 'right' ? toggle(task) : removeTask(task) }}
                on:contextmenu|preventDefault={(e) => openMenu({ currentTarget: { getBoundingClientRect: () => ({ left: e.clientX, top: e.clientY, bottom: e.clientY, x: e.clientX, y: e.clientY }) } }, task)}>
                <span class="swipe-bg swipe-done" aria-hidden="true"><span class="material-symbols-rounded">check_circle</span></span>
                <span class="swipe-bg swipe-delete" aria-hidden="true"><span class="material-symbols-rounded">delete</span></span>
                <div class="swipe-body">
                  {#if byList && task.editable}
                    <span class="handle" use:dragHandle data-no-pull-sync aria-label={$_('notes.drag_to_reorder')}>
                      <span class="material-symbols-rounded">drag_indicator</span>
                    </span>
                  {/if}
                  <button class="task-check" class:on={task.checked} disabled={!task.editable} on:click={() => toggle(task)}
                    aria-label={task.checked ? $_('notes.uncheck_item') : $_('notes.check_item')}>
                    <span class="material-symbols-rounded" class:fill={task.checked}>{task.checked ? 'check_circle' : 'radio_button_unchecked'}</span>
                  </button>
                  <div class="task-main">
                    {#if editUuid === task.uuid}
                      <input class="task-edit" bind:this={editInput} bind:value={draft} maxlength="5000" aria-label={$_('tasks.edit')}
                        on:keydown={(e) => onEditKey(e, task)} on:blur={() => commitEdit(task)} />
                    {:else}
                      <button class="task-text" disabled={!task.editable} on:click={() => startEdit(task)} title={task.editable ? $_('tasks.edit') : undefined}>{task.text}</button>
                    {/if}
                    {#if !byList}
                      <button class="task-list-label" on:click={() => openNote(task.note)} title={$_('tasks.open_note')}>
                        <span class="dot" style="background:{colorDot(task.note.color)}"></span>
                        <span class="task-list-name">{task.note.title || $_('notes.untitled')}</span>
                      </button>
                    {/if}
                  </div>
                  <button class="task-due due-{task.due_date ? dueStatus(task.due_date) : 'none'}" disabled={!task.editable}
                    on:click={(e) => openDue(e, task)} title={$_('due.title')}
                    aria-label={task.due_date ? `${$_('due.title')}: ${dueLabel(task.due_date, $_)}` : $_('due.add')}>
                    <span class="material-symbols-rounded">{task.due_repeat ? 'event_repeat' : 'event'}</span>
                    {#if task.due_date}<span>{dueLabel(task.due_date, $_)}</span>{/if}
                  </button>
                  {#if task.editable}
                    <button class="task-more" on:click={(e) => openMenu(e, task)} aria-label={$_('tasks.options')} aria-haspopup="menu">
                      <span class="material-symbols-rounded">more_vert</span>
                    </button>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
          {#if byList && canEdit(g.note)}
            <form class="list-add" on:submit|preventDefault={() => addToList(g.note)}>
              <span class="material-symbols-rounded">add</span>
              <input bind:value={listDrafts[g.note.id]} placeholder={$_('tasks.add_placeholder')} maxlength="5000"
                aria-label={`${$_('tasks.add_placeholder')}: ${groupTitle(g)}`} />
            </form>
          {/if}
        </section>
      {/each}

      {#if completed.length}
        <section class="task-group completed">
          <button class="completed-toggle" on:click={() => showCompleted = !showCompleted} aria-expanded={showCompleted}>
            <span class="material-symbols-rounded" class:open={showCompleted}>expand_more</span>
            {$_('tasks.completed')}<span class="count">{completed.length}</span>
          </button>
          {#if showCompleted}
            <ul class="task-list" transition:slide={{ duration: 180 }}>
              {#each completed as task (task.key)}
                <li class="task done" animate:flip={{ duration: FLIP_MS }}>
                  <div class="swipe-body">
                    <button class="task-check on" disabled={!task.editable} on:click={() => patchTask(task, { checked: false })}
                      aria-label={$_('notes.uncheck_item')}>
                      <span class="material-symbols-rounded fill">check_circle</span>
                    </button>
                    <div class="task-main">
                      <span class="task-text static">{task.text}</span>
                      <button class="task-list-label" on:click={() => openNote(task.note)}>
                        <span class="dot" style="background:{colorDot(task.note.color)}"></span>
                        <span class="task-list-name">{task.note.title || $_('notes.untitled')}</span>
                      </button>
                    </div>
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}
    {/if}
  </div>
</div>

<Popover bind:open={dueOpen} anchor={dueAnchor} label={$_('due.title')}>
  {#if dueOpen}<DuePicker value={dueFor?.due_date || null} repeat={dueFor?.due_repeat || null} repeats
    on:select={(e) => setDue(e.detail)} on:repeat={(e) => setRepeat(e.detail)} />{/if}
</Popover>
<Popover bind:open={quickDueOpen} anchor={quickDueAnchor} label={$_('due.title')}>
  {#if quickDueOpen}<DuePicker value={newDue} repeat={newRepeat} repeats
    on:select={(e) => { newDue = e.detail; if (!e.detail) newRepeat = null; quickDueOpen = false; }}
    on:repeat={(e) => { newRepeat = e.detail; if (e.detail && !newDue) newDue = todayStr(); }} />{/if}
</Popover>
<Popover bind:open={listPickOpen} anchor={listPickAnchor} label={$_('tasks.move_to_list')}>
  {#if listPickOpen}
    <div class="menu" role="menu">
      <p class="menu-title">{$_('tasks.add_to_list')}</p>
      <button class="menu-row" class:current={!quickList} role="menuitemradio" aria-checked={!quickList} on:click={() => { quickListId = null; listPickOpen = false; }}>
        <span class="material-symbols-rounded">task_alt</span><span class="menu-label">{inboxTitle}</span>
        {#if !quickList}<span class="material-symbols-rounded menu-check">check</span>{/if}
      </button>
      {#each listsInTasks.filter(n => !isTasksInbox(n, inboxTitle)) as n (n.id)}
        <button class="menu-row" class:current={quickListId === n.id} role="menuitemradio" aria-checked={quickListId === n.id} on:click={() => { quickListId = n.id; listPickOpen = false; }}>
          <span class="dot" style="background:{colorDot(n.color)}"></span><span class="menu-label">{n.title || $_('notes.untitled')}</span>
          {#if quickListId === n.id}<span class="material-symbols-rounded menu-check">check</span>{/if}
        </button>
      {/each}
      {#if otherLists.length}
        <p class="menu-section">{$_('tasks.other_lists')}<span>{$_('tasks.other_lists_hint')}</span></p>
        {#each otherLists as n (n.id)}
          <button class="menu-row" class:current={quickListId === n.id} role="menuitemradio" aria-checked={quickListId === n.id} on:click={() => { quickListId = n.id; listPickOpen = false; }}>
            <span class="dot" style="background:{colorDot(n.color)}"></span><span class="menu-label">{n.title || $_('notes.untitled')}</span>
            {#if quickListId === n.id}<span class="material-symbols-rounded menu-check">check</span>{/if}
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</Popover>
<Popover bind:open={menuOpen} anchor={menuAnchor} label={$_('notes.more_options')}>
  {#if menuOpen && menuFor}
    <div class="menu" role="menu">
      {#if menuMode === 'move'}
        <p class="menu-title">{$_('tasks.move_to_list')}</p>
        {#each listsInTasks.filter(n => n.id !== menuFor.note.id) as n (n.id)}
          <button class="menu-row" role="menuitem" on:click={() => { const t = menuFor; menuOpen = false; moveTask(t, n); }}>
            <span class="dot" style="background:{colorDot(n.color)}"></span><span class="menu-label">{n.title || $_('notes.untitled')}</span>
          </button>
        {/each}
        {#if otherLists.filter(n => n.id !== menuFor.note.id).length}
          <p class="menu-section">{$_('tasks.other_lists')}{#if !menuFor.due_date}<span>{$_('tasks.other_lists_hint')}</span>{/if}</p>
          {#each otherLists.filter(n => n.id !== menuFor.note.id) as n (n.id)}
            <button class="menu-row" role="menuitem" on:click={() => { const t = menuFor; menuOpen = false; moveTask(t, n); }}>
              <span class="dot" style="background:{colorDot(n.color)}"></span><span class="menu-label">{n.title || $_('notes.untitled')}</span>
            </button>
          {/each}
        {/if}
        {#if writableLists.filter(n => n.id !== menuFor.note.id).length === 0}
          <p class="menu-empty">{$_('tasks.no_other_lists')}</p>
        {/if}
      {:else}
        <p class="menu-title menu-task">{menuFor.text}</p>
        <button class="menu-row" role="menuitem" on:click={() => menuAction('edit')}>
          <span class="material-symbols-rounded">edit</span><span class="menu-label">{$_('tasks.edit')}</span><kbd>e</kbd>
        </button>
        <button class="menu-row" role="menuitem" on:click={() => menuAction('due')}>
          <span class="material-symbols-rounded">event_repeat</span><span class="menu-label">{$_('tasks.due_and_repeat')}</span><kbd>d</kbd>
        </button>
        <button class="menu-row" role="menuitem" on:click={() => menuAction('move')}>
          <span class="material-symbols-rounded">drive_file_move</span><span class="menu-label">{$_('tasks.move_to_list')}</span><kbd>m</kbd>
        </button>
        <button class="menu-row" role="menuitem" on:click={() => menuAction('open')}>
          <span class="material-symbols-rounded">open_in_new</span><span class="menu-label">{$_('tasks.open_note')}</span><kbd>o</kbd>
        </button>
        <button class="menu-row danger" role="menuitem" on:click={() => menuAction('delete')}>
          <span class="material-symbols-rounded">delete</span><span class="menu-label">{$_('tasks.delete')}</span><kbd>#</kbd>
        </button>
      {/if}
    </div>
  {/if}
</Popover>

{#if editing}
  {#key editing}
    <NoteEditor note={editing.note || null} originId={null} on:close={closeEditor} />
  {/key}
{/if}

<style>
  .tasks-body {
    display: flex; flex-direction: column; gap: 18px;
    width: 100%; max-width: 820px; margin: 0 auto;
    padding: 16px var(--page-px) calc(var(--nav-h) + var(--safe-bottom) + 96px);
  }
  .tasks-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .quick-add {
    flex: 1 1 360px; min-width: 0; height: 52px;
    display: flex; align-items: center; gap: 6px; padding: 0 6px 0 14px;
    background: var(--surface-1); border: 1px solid var(--border-strong); border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
  }
  .quick-add:focus-within { border-color: var(--accent); box-shadow: var(--shadow-md), 0 0 0 4px var(--accent-dim); }
  .quick-add > .material-symbols-rounded { color: var(--accent); font-size: 22px; }
  .quick-add input { flex: 1; min-width: 60px; background: none; border: none; outline: none; color: var(--text-1); font-size: 15px; }
  .qa-chip {
    height: 36px; max-width: 150px; padding: 0 8px; border-radius: 10px; flex-shrink: 0;
    display: inline-flex; align-items: center; gap: 4px; color: var(--text-3); font-size: 13px; font-weight: 600;
  }
  .qa-chip .material-symbols-rounded { font-size: 19px; }
  .qa-chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qa-chip.set { color: var(--accent); background: var(--accent-dim); }
  .qa-chip:hover { color: var(--text-1); }
  .qa-go { height: 40px; }
  .group-toggle { display: flex; padding: 3px; gap: 2px; border-radius: var(--radius-md); background: var(--surface-2); border: 1px solid var(--border); }
  .group-toggle button { height: 36px; padding: 0 12px; border-radius: 9px; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--text-2); }
  .group-toggle button .material-symbols-rounded { font-size: 17px; }
  .group-toggle button.on { background: var(--surface-1); color: var(--text-1); box-shadow: var(--shadow-sm); }

  .task-group { display: flex; flex-direction: column; gap: 6px; }
  .group-title {
    display: flex; align-items: center; gap: 8px; padding: 6px 4px 2px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3);
  }
  .task-group.overdue .group-title { color: var(--danger); }
  .group-title .count, .completed-toggle .count { font-weight: 600; opacity: 0.7; }
  .group-note { display: inline-flex; align-items: center; gap: 8px; text-transform: none; letter-spacing: 0; font-size: 15px; font-weight: 600; color: var(--text-1); font-family: var(--font-note-title); }
  .group-note .material-symbols-rounded { font-size: 15px; color: var(--text-3); }
  .group-note:hover .material-symbols-rounded { color: var(--accent); }
  .task-list { list-style: none; display: flex; flex-direction: column; gap: 6px; min-height: 2px; }

  /* A row: the body slides over two backdrops while it's swiped. */
  .task {
    position: relative; border-radius: var(--radius-md); outline: none;
  }
  .swipe-body {
    position: relative; z-index: 1;
    display: flex; align-items: center; gap: 8px; min-height: 56px; padding: 6px 6px 6px 6px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-md);
    transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
  }
  @media (hover: hover) { .task:hover .swipe-body { border-color: var(--border-strong); transform: translateY(-1px); box-shadow: var(--shadow-sm); } }
  .task:focus-visible .swipe-body { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .task.editing .swipe-body { border-color: var(--accent); }
  .swipe-bg {
    position: absolute; inset: 0; display: none; align-items: center; border-radius: var(--radius-md);
    padding: 0 20px; color: #fff;
  }
  .swipe-bg .material-symbols-rounded { font-size: 24px; }
  .swipe-done { justify-content: flex-start; background: color-mix(in srgb, var(--accent) 70%, #1b5e20); }
  .swipe-delete { justify-content: flex-end; background: var(--danger); }
  :global(.task.swiping[data-swipe^="right"]) .swipe-done,
  :global(.task.swiping[data-swipe^="left"]) .swipe-delete { display: flex; }
  :global(.task.swiping[data-swipe$="peek"]) .swipe-bg { opacity: 0.55; }

  .handle { width: 22px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: var(--text-3); cursor: grab; opacity: 0; transition: opacity 120ms ease; touch-action: none; }
  .handle .material-symbols-rounded { font-size: 20px; }
  .task:hover .handle, .task:focus-within .handle { opacity: 1; }
  @media (pointer: coarse) { .handle { opacity: 0.55; } }
  .task-check { width: 40px; height: 40px; flex-shrink: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
  .task-check .material-symbols-rounded { font-size: 24px; transition: transform 160ms ease; }
  .task-check:hover:not(:disabled) { color: var(--accent); }
  .task-check:hover:not(:disabled) .material-symbols-rounded { transform: scale(1.1); }
  .task-check.on { color: var(--accent); }
  .task-main { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 2px 0; }
  .task-text {
    max-width: 100%; text-align: left; font-size: 15px; line-height: 1.35; color: var(--text-1);
    overflow-wrap: anywhere; transition: color 200ms ease; cursor: text; border-radius: 6px; padding: 1px 2px; margin: -1px -2px;
  }
  .task-text:disabled { cursor: default; }
  .task-text.static { cursor: default; }
  .task.done .task-text { text-decoration: line-through; color: var(--text-3); }
  .task-edit {
    width: 100%; font: inherit; font-size: 15px; line-height: 1.35; color: var(--text-1);
    background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 8px; padding: 4px 8px; outline: none;
  }
  .task-edit:focus { border-color: var(--accent); }
  .task-list-label {
    max-width: 100%; min-width: 0; display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--text-3); border-radius: 6px; padding: 1px 2px; margin: 0 -2px;
  }
  .task-list-label:hover { color: var(--text-1); }
  .task-list-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .task-due { flex-shrink: 0; height: 30px; padding: 0 9px 0 7px; display: inline-flex; align-items: center; gap: 4px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; color: var(--text-3); }
  .task-due .material-symbols-rounded { font-size: 16px; }
  .task-due.due-none { opacity: 0.55; }
  .task-due.due-none:hover { opacity: 1; }
  .task-due.due-overdue { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
  .task-due.due-today { color: var(--accent); background: var(--accent-dim); }
  .task-due:not(.due-none):not(.due-overdue):not(.due-today) { background: color-mix(in srgb, var(--text-1) 6%, transparent); color: var(--text-2); }
  .task-due:disabled { cursor: default; }
  .task-more { width: 34px; height: 34px; flex-shrink: 0; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: var(--text-3); opacity: 0; transition: opacity 120ms ease; }
  .task-more:hover { color: var(--text-1); background: color-mix(in srgb, var(--text-1) 8%, transparent); }
  .task:hover .task-more, .task:focus-within .task-more { opacity: 1; }
  @media (pointer: coarse) { .task-more { opacity: 0.7; } }
  .fill { font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24; }

  .list-add {
    display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px;
    border: 1px dashed var(--border-strong); border-radius: var(--radius-md); color: var(--text-3);
  }
  .list-add:focus-within { border-style: solid; border-color: var(--accent); color: var(--accent); }
  .list-add .material-symbols-rounded { font-size: 20px; }
  .list-add input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--text-1); font-size: 14px; }

  .completed-toggle {
    align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 10px 0 4px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); border-radius: 10px;
  }
  .completed-toggle:hover { color: var(--text-1); }
  .completed-toggle .material-symbols-rounded { font-size: 20px; transition: transform 180ms ease; transform: rotate(-90deg); }
  .completed-toggle .material-symbols-rounded.open { transform: rotate(0deg); }
  .completed .swipe-body { background: transparent; border-style: dashed; }

  .menu { display: flex; flex-direction: column; gap: 2px; min-width: 240px; max-width: 320px; }
  .menu-title { font-size: 13px; font-weight: 600; color: var(--text-2); margin: 0 6px 6px; }
  .menu-title.menu-task { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu-row { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 10px; border-radius: 10px; font-size: 14px; color: var(--text-1); text-align: left; }
  .menu-row:hover { background: color-mix(in srgb, var(--text-1) 7%, transparent); }
  .menu-row .material-symbols-rounded { font-size: 20px; color: var(--accent); }
  .menu-row.danger, .menu-row.danger .material-symbols-rounded { color: var(--danger); }
  .menu-row .dot { margin: 0 6px; }
  .menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu-row kbd { font: 600 11px/1 var(--font-sans, inherit); color: var(--text-3); border: 1px solid var(--border); border-radius: 5px; padding: 3px 6px; }
  .menu-check { color: var(--accent); }
  .menu-empty { font-size: 13px; color: var(--text-3); padding: 8px 10px; }
  .menu-section {
    display: flex; flex-direction: column; gap: 2px; margin: 8px 6px 4px; padding-top: 8px; border-top: 1px solid var(--border);
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3);
  }
  .menu-section span { font-size: 12px; font-weight: 400; letter-spacing: 0; text-transform: none; }
  @media (pointer: coarse) { .menu-row kbd { display: none; } }

  .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; margin: 10vh auto 0; max-width: 360px; }
  .empty-icon { font-size: 48px; color: var(--accent); margin-bottom: 8px; }
  .empty h2 { font-family: var(--font-note-title); font-weight: 500; font-size: 24px; }
  .empty p { color: var(--text-3); font-size: 14px; }
  .task-skeleton { display: flex; flex-direction: column; gap: 6px; }
  .task-skeleton div { height: 56px; border-radius: var(--radius-md); background: var(--surface-1); border: 1px solid var(--border); animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.55; } }
  @media (max-width: 600px) {
    .group-toggle { width: 100%; }
    .group-toggle button { flex: 1; justify-content: center; }
    .qa-go { display: none; }
    .qa-chip { max-width: 96px; }
  }
</style>
