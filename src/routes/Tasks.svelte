<script>
  /**
   * Tasks: open checklist items that have a due date, plus everything on
   * checklists shown in Tasks (or every checklist, with that setting on).
   *
   * Nothing new is stored: a task is a checklist item, so checking one here
   * checks it in its note (and syncs the same way). Group by due date
   * (Overdue, Today, Tomorrow, This Week, Later, No Due Date) or by note.
   * Quick add puts new tasks in a checklist called "Tasks", created the
   * first time it's needed.
   */
  import { onMount, tick } from 'svelte';
  import { fly, slide } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { _ } from 'svelte-i18n';
  import { bannerStyle, tasksGroupBy, tasksAllChecklists } from '../stores/settings.js';
  import { isTask, isTasksInbox } from '../../server/lib/task-rules.js';
  import { NoteApi } from '../lib/api.js';
  import { notesChanged, signalNotesChanged } from '../stores/notes.js';
  import { showError, showUndo } from '../stores/toast.js';
  import { canEdit } from '../lib/note-sharing.js';
  import { colorDot } from '../lib/note-colors.js';
  import { groupByDue, dueLabel, dueStatus, todayStr } from '../lib/due-dates.js';
  import Popover from '../components/notes/Popover.svelte';
  import DuePicker from '../components/notes/DuePicker.svelte';
  import NoteEditor from '../components/notes/NoteEditor.svelte';

  let notes = [];
  let loading = true;
  let editing = null;
  let loadSeq = 0;

  async function load() {
    const seq = ++loadSeq;
    try {
      const rows = await NoteApi.getNotes({ view: 'notes' });
      if (seq === loadSeq) notes = (rows || []).filter(n => n.kind === 'checklist');
    } catch (e) {
      if (seq === loadSeq) showError(e.message);
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }
  $: $notesChanged, load();

  // Items being checked stay on screen for a moment, struck through.
  let leaving = new Set();
  // A task: an open item with a due date, or on a checklist shown in Tasks (see task-rules.js).
  $: tasks = notes.flatMap(n => (n.items || [])
    .filter(i => leaving.has(i.uuid) ? String(i.text || '').trim() : isTask(n, i, { allChecklists: $tasksAllChecklists || isTasksInbox(n, $_('tasks.inbox_title')) }))
    .map(i => ({ ...i, key: i.uuid, note: n, editable: canEdit(n) })));
  $: groups = $tasksGroupBy === 'note'
    ? notes.map(n => ({ key: `n${n.id}`, note: n, items: tasks.filter(t => t.note.id === n.id) })).filter(g => g.items.length)
    : groupByDue(tasks);

  function groupTitle(g) {
    if (g.note) return g.note.title || $_('notes.untitled');
    return $_(`tasks.group_${g.key}`);
  }

  async function toggle(task) {
    if (!task.editable) return;
    const checked = !task.checked;
    notes = notes.map(n => n.id !== task.note.id ? n : { ...n, items: n.items.map(i => i.uuid === task.uuid ? { ...i, checked } : i) });
    if (checked) {
      leaving = new Set([...leaving, task.uuid]);
      setTimeout(() => { leaving.delete(task.uuid); leaving = new Set(leaving); }, 700);
    }
    try {
      await NoteApi.updateItem(task.note.id, task.uuid, { checked });
      if (checked) {
        showUndo($_('tasks.done', { values: { text: task.text.slice(0, 40) } }), async () => {
          await NoteApi.updateItem(task.note.id, task.uuid, { checked: false }).catch(() => {});
          signalNotesChanged();
        }, $_('common.undo'));
      }
    } catch (e) {
      showError(e.message);
      load();
    }
  }

  let dueFor = null, dueAnchor = null, dueOpen = false;
  function openDue(e, task) { if (!task.editable) return; dueFor = task; dueAnchor = e.currentTarget.getBoundingClientRect(); dueOpen = true; }
  async function setDue(value) {
    dueOpen = false;
    const task = dueFor;
    if (!task) return;
    notes = notes.map(n => n.id !== task.note.id ? n : { ...n, items: n.items.map(i => i.uuid === task.uuid ? { ...i, due_date: value } : i) });
    try { await NoteApi.updateItem(task.note.id, task.uuid, { due_date: value }); }
    catch (e) { showError(e.message); load(); }
  }

  // Quick add
  let newText = '';
  let newDue = null;
  let adding = false;
  let quickDueAnchor = null, quickDueOpen = false;
  async function add() {
    const text = newText.trim();
    if (!text || adding) return;
    adding = true;
    try {
      const title = $_('tasks.inbox_title');
      let inbox = notes.find(n => isTasksInbox(n, title) && n.share_role !== 'view' && n.share_role !== 'edit');
      if (!inbox) inbox = await NoteApi.createNote({ title, kind: 'checklist', items: [], in_tasks: true });
      else if (!inbox.in_tasks) await NoteApi.updateNote(inbox.id, { in_tasks: true });
      const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
      await NoteApi.addItem(inbox.id, { uuid, text, due_date: newDue });
      newText = '';
      newDue = null;
      signalNotesChanged();
    } catch (e) {
      showError(e.message);
    } finally {
      adding = false;
    }
  }

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

  onMount(load);
</script>

<div class="page-shell tasks-page">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('nav.tasks')}</h1>
  </header>

  <div class="tasks-body">
    <div class="tasks-toolbar">
      <form class="quick-add" on:submit|preventDefault={add}>
        <span class="material-symbols-rounded">add_task</span>
        <input bind:value={newText} placeholder={$_('tasks.add_placeholder')} aria-label={$_('tasks.add_placeholder')} maxlength="5000" />
        <button type="button" class="qa-due" class:set={!!newDue} on:click={(e) => { quickDueAnchor = e.currentTarget.getBoundingClientRect(); quickDueOpen = true; }}
          title={$_('due.title')} aria-label={$_('due.title')}>
          <span class="material-symbols-rounded">event</span>{#if newDue}<span>{dueLabel(newDue, $_)}</span>{/if}
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
    {:else if !tasks.length}
      <div class="empty">
        <span class="material-symbols-rounded empty-icon">task_alt</span>
        <h2>{$_('tasks.empty_title')}</h2>
        <p>{$_('tasks.empty_body')}</p>
      </div>
    {:else}
      {#each groups as g (g.key)}
        <section class="task-group" class:overdue={g.key === 'overdue'} transition:slide={{ duration: 180 }}>
          <h2 class="group-title">
            {#if g.note}
              <button class="group-note" on:click={() => openNote(g.note)}>
                <span class="dot" style="background:{colorDot(g.note.color)}"></span>{groupTitle(g)}
                <span class="material-symbols-rounded">open_in_new</span>
              </button>
            {:else}
              {groupTitle(g)}
            {/if}
            <span class="count">{g.items.length}</span>
          </h2>
          <ul class="task-list">
            {#each g.items as task (task.key)}
              <li class="task" class:done={task.checked} animate:flip={{ duration: 220 }} out:fly={{ x: 24, duration: 200 }}>
                <button class="task-check" class:on={task.checked} disabled={!task.editable} on:click={() => toggle(task)}
                  aria-label={task.checked ? $_('notes.uncheck_item') : $_('notes.check_item')}>
                  <span class="material-symbols-rounded" class:fill={task.checked}>{task.checked ? 'check_circle' : 'radio_button_unchecked'}</span>
                </button>
                <span class="task-text">{task.text}</span>
                {#if $tasksGroupBy !== 'note'}
                  <button class="task-note" on:click={() => openNote(task.note)} title={task.note.title || $_('notes.untitled')}>
                    <span class="dot" style="background:{colorDot(task.note.color)}"></span>
                    <span class="task-note-title">{task.note.title || $_('notes.untitled')}</span>
                  </button>
                {/if}
                <button class="task-due due-{task.due_date ? dueStatus(task.due_date) : 'none'}" disabled={!task.editable}
                  on:click={(e) => openDue(e, task)} title={$_('due.title')} aria-label={task.due_date ? `${$_('due.title')}: ${dueLabel(task.due_date, $_)}` : $_('due.add')}>
                  <span class="material-symbols-rounded">event</span>
                  {#if task.due_date}<span>{dueLabel(task.due_date, $_)}</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  </div>
</div>

<Popover bind:open={dueOpen} anchor={dueAnchor}>
  {#if dueOpen}<DuePicker value={dueFor?.due_date || null} on:select={(e) => setDue(e.detail)} />{/if}
</Popover>
<Popover bind:open={quickDueOpen} anchor={quickDueAnchor}>
  {#if quickDueOpen}<DuePicker value={newDue} on:select={(e) => { newDue = e.detail; quickDueOpen = false; }} />{/if}
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
    display: flex; align-items: center; gap: 8px; padding: 0 6px 0 14px;
    background: var(--surface-1); border: 1px solid var(--border-strong); border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
  }
  .quick-add:focus-within { border-color: var(--accent); box-shadow: var(--shadow-md), 0 0 0 4px var(--accent-dim); }
  .quick-add > .material-symbols-rounded { color: var(--accent); font-size: 22px; }
  .quick-add input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--text-1); font-size: 15px; }
  .qa-due { height: 36px; padding: 0 8px; border-radius: 10px; display: inline-flex; align-items: center; gap: 4px; color: var(--text-3); font-size: 13px; font-weight: 600; }
  .qa-due.set { color: var(--accent); background: var(--accent-dim); }
  .qa-due:hover { color: var(--text-1); }
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
  .group-title .count { font-weight: 600; opacity: 0.7; }
  .group-note { display: inline-flex; align-items: center; gap: 8px; text-transform: none; letter-spacing: 0; font-size: 15px; font-weight: 600; color: var(--text-1); font-family: var(--font-note-title); }
  .group-note .material-symbols-rounded { font-size: 15px; color: var(--text-3); }
  .group-note:hover .material-symbols-rounded { color: var(--accent); }
  .task-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .task {
    display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 6px 8px 6px 6px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-md);
    transition: border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
  }
  @media (hover: hover) { .task:hover { border-color: var(--border-strong); transform: translateY(-1px); box-shadow: var(--shadow-sm); } }
  .task-check { width: 40px; height: 40px; flex-shrink: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
  .task-check .material-symbols-rounded { font-size: 24px; transition: transform 160ms ease; }
  .task-check:hover:not(:disabled) { color: var(--accent); }
  .task-check:hover:not(:disabled) .material-symbols-rounded { transform: scale(1.1); }
  .task-check.on { color: var(--accent); }
  .task-text { flex: 1; min-width: 0; font-size: 15px; color: var(--text-1); overflow-wrap: anywhere; transition: color 200ms ease; }
  .task.done .task-text { text-decoration: line-through; color: var(--text-3); }
  .task-note { max-width: 34%; flex-shrink: 1; min-width: 0; height: 28px; padding: 0 10px 0 8px; display: inline-flex; align-items: center; gap: 6px; border-radius: var(--radius-full); background: color-mix(in srgb, var(--text-1) 6%, transparent); font-size: 12px; color: var(--text-2); }
  .task-note:hover { background: color-mix(in srgb, var(--text-1) 11%, transparent); color: var(--text-1); }
  .task-note-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .task-due { flex-shrink: 0; height: 30px; padding: 0 9px 0 7px; display: inline-flex; align-items: center; gap: 4px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; color: var(--text-3); }
  .task-due .material-symbols-rounded { font-size: 16px; }
  .task-due.due-none { opacity: 0.55; }
  .task-due.due-none:hover { opacity: 1; }
  .task-due.due-overdue { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
  .task-due.due-today { color: var(--accent); background: var(--accent-dim); }
  .task-due:not(.due-none):not(.due-overdue):not(.due-today) { background: color-mix(in srgb, var(--text-1) 6%, transparent); color: var(--text-2); }
  .task-due:disabled { cursor: default; }
  .fill { font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24; }

  .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; margin: 10vh auto 0; max-width: 360px; }
  .empty-icon { font-size: 48px; color: var(--accent); margin-bottom: 8px; }
  .empty h2 { font-family: var(--font-note-title); font-weight: 500; font-size: 24px; }
  .empty p { color: var(--text-3); font-size: 14px; }
  .task-skeleton { display: flex; flex-direction: column; gap: 6px; }
  .task-skeleton div { height: 52px; border-radius: var(--radius-md); background: var(--surface-1); border: 1px solid var(--border); animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.55; } }
  @media (max-width: 600px) {
    .task-note { display: none; }
    .group-toggle { width: 100%; }
    .group-toggle button { flex: 1; justify-content: center; }
    .qa-go { display: none; }
  }
</style>
