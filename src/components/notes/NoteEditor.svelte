<script>
  /**
   * NoteEditor: open, create, and edit a single note.
   *
   * Centered panel on wide screens, full screen on phones. Saves as you
   * type (debounced) and never shows a Save button. A new note is only
   * created once it has content, and closing an untouched new note leaves
   * nothing behind.
   *
   * Every save goes through one queue so operations on a brand-new note
   * wait for its create call instead of racing it.
   */
  import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';
  import { NoteApi } from '../../lib/api.js';
  import { labelsById, signalNotesChanged, refreshLabels } from '../../stores/notes.js';
  import { noteColorStyle, colorDot } from '../../lib/note-colors.js';
  import { isEmptyNote } from '../../lib/note-preview.js';
  import { relativeTime } from '../../lib/relative-time.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { showError, showInfo } from '../../stores/toast.js';
  import TipTapEditor from './TipTapEditor.svelte';
  import ChecklistEditor from './ChecklistEditor.svelte';
  import ColorPalette from './ColorPalette.svelte';
  import LabelPicker from './LabelPicker.svelte';
  import Popover from './Popover.svelte';
  import VersionHistory from './VersionHistory.svelte';
  import ReminderPicker from './ReminderPicker.svelte';
  import ReminderChip from './ReminderChip.svelte';
  import { ensureReminderPermission, rescheduleReminders } from '../../lib/note-reminders.js';

  /** Existing note, or null to create one. */
  export let note = null;
  /** Kind for a new note. */
  export let initialKind = 'text';
  /** Labels to apply to a new note (e.g. when created from a label view). */
  export let initialLabels = [];
  /** Content for a new note, e.g. from the share sheet: { title, body_md }. */
  export let prefill = null;

  const dispatch = createEventDispatcher();
  const TEXT_SAVE_MS = 700;

  let noteId = note?.id ?? null;
  let title = note?.title ?? prefill?.title ?? '';
  let body = note?.body_md ?? prefill?.body_md ?? '';
  let kind = note?.kind ?? initialKind;
  let color = note?.color ?? null;
  let pinned = !!note?.pinned;
  let archived = !!note?.archived;
  let trashed = !!note?.trashed_at;
  let noteLabels = note?.labels ? [...note.labels] : [...initialLabels];
  let items = note?.items ? note.items.map(i => ({ ...i })) : [];
  let updatedAt = note?.updated_at ?? null;
  let reminderAt = note?.reminder_at ?? null;
  let reminderRepeat = note?.reminder_rrule ?? null;
  let reminderTz = note?.reminder_tz ?? null;
  let editorKey = 0;
  let touched = false;

  let checklistRef;
  let bodyRef;
  let titleEl;
  let textTimer = null;
  let queue = Promise.resolve();
  let saving = false;
  let showHistory = false;
  let colorOpen = false, labelsOpen = false, reminderOpen = false;
  let colorAnchor = null, labelsAnchor = null, reminderAnchor = null;
  let narrow = typeof window !== 'undefined' && window.innerWidth < 600;

  $: readOnly = trashed;
  $: chips = noteLabels.map(id => $labelsById.get(id)).filter(Boolean);
  $: reminderNote = { reminder_at: reminderAt, reminder_rrule: reminderRepeat, reminder_tz: reminderTz };

  function enqueue(fn) {
    saving = true;
    const run = queue.then(fn).catch(e => { showError(e?.message || $_('notes.save_failed')); });
    queue = run.finally(() => { saving = false; });
    return run;
  }

  function apply(n) {
    if (!n) return;
    noteId = n.id;
    updatedAt = n.updated_at;
    pinned = !!n.pinned;
    archived = !!n.archived;
    trashed = !!n.trashed_at;
    color = n.color;
    noteLabels = [...(n.labels || [])];
    reminderAt = n.reminder_at ?? null;
    reminderRepeat = n.reminder_rrule ?? null;
    reminderTz = n.reminder_tz ?? null;
  }

  /** Create the note on first content. Resolves to its id. */
  async function ensureNote() {
    if (noteId) return noteId;
    const created = await NoteApi.createNote({
      title, body_md: kind === 'text' ? body : '', kind, color, pinned,
      reminder_at: reminderAt, reminder_rrule: reminderRepeat, reminder_tz: reminderTz,
      labels: noteLabels,
      items: kind === 'checklist' ? items.map((i, idx) => ({ uuid: i.uuid, text: i.text, checked: i.checked, position: i.position ?? idx + 1 })) : [],
    });
    apply(created);
    return noteId;
  }

  function scheduleText() {
    touched = true;
    clearTimeout(textTimer);
    textTimer = setTimeout(saveText, TEXT_SAVE_MS);
  }

  function saveText() {
    clearTimeout(textTimer);
    textTimer = null;
    return enqueue(async () => {
      if (!noteId) {
        if (isEmptyNote({ title, body_md: body, items })) return;
        await ensureNote();
        return;
      }
      apply(await NoteApi.updateNote(noteId, kind === 'text' ? { title, body_md: body } : { title }));
    });
  }

  function patch(p) {
    touched = true;
    return enqueue(async () => {
      if (!noteId) {
        if (isEmptyNote({ title, body_md: body, items }) && !p.labels && !p.pinned && !p.reminder_at) return;
        await ensureNote();
        if (!('archived' in p)) return;
      }
      apply(await NoteApi.updateNote(noteId, p));
    });
  }

  // ── Checklist ops ─────────────────────────────────────────────────
  function onItemAdd(e) {
    touched = true;
    const { uuid, text, position } = e.detail;
    items = [...items, { uuid, text, checked: false, position }];
    enqueue(async () => {
      if (!noteId) { await ensureNote(); return; }
      const n = await NoteApi.addItem(noteId, { uuid, text, position });
      updatedAt = n?.updated_at ?? updatedAt;
    });
  }
  function onItemUpdate(e) {
    touched = true;
    const { uuid, patch: p } = e.detail;
    items = items.map(i => i.uuid === uuid ? { ...i, ...p } : i);
    enqueue(async () => {
      if (!noteId) { await ensureNote(); return; }
      const n = await NoteApi.updateItem(noteId, uuid, p);
      updatedAt = n?.updated_at ?? updatedAt;
    });
  }
  function onItemDelete(e) {
    touched = true;
    const { uuid } = e.detail;
    items = items.filter(i => i.uuid !== uuid);
    enqueue(async () => {
      if (!noteId) return;
      const n = await NoteApi.deleteItem(noteId, uuid);
      updatedAt = n?.updated_at ?? updatedAt;
    });
  }
  function onItemReorder(e) {
    const { uuids } = e.detail;
    enqueue(async () => {
      if (!noteId) { await ensureNote(); return; }
      await NoteApi.reorderItems(noteId, uuids);
    });
  }

  // ── Actions ───────────────────────────────────────────────────────
  function togglePin() { pinned = !pinned; patch({ pinned }); }
  function setColor(c) { color = c; patch({ color: c }); }
  function setLabels(ids) { noteLabels = ids; patch({ labels: ids }); }

  async function setReminder(detail) {
    reminderOpen = false;
    reminderAt = detail.reminder_at; reminderRepeat = detail.reminder_rrule; reminderTz = detail.reminder_tz;
    await ensureReminderPermission();
    await patch(detail);
    rescheduleReminders();
  }
  async function clearReminder() {
    reminderOpen = false;
    reminderAt = null; reminderRepeat = null; reminderTz = null;
    await patch({ reminder_at: null });
    rescheduleReminders();
  }
  function openReminder(e) {
    reminderAnchor = (e?.currentTarget || document.activeElement)?.getBoundingClientRect?.() || null;
    reminderOpen = true;
  }

  async function convert() {
    const next = kind === 'text' ? 'checklist' : 'text';
    checklistRef?.flush?.();
    await saveText();
    await enqueue(async () => {
      if (!noteId) {
        if (next === 'checklist') {
          items = String(body || '').split('\n').map(l => l.trim()).filter(Boolean)
            .map((line, i) => {
              const bare = line.replace(/^([-*+]|\d+[.)])\s+/, '');
              const struck = bare.match(/^~~(.+)~~$/);
              return { uuid: crypto.randomUUID?.() || String(Date.now() + i), text: struck ? struck[1] : bare, checked: !!struck, position: i + 1 };
            });
          body = '';
        } else {
          body = items.map(i => i.checked ? `~~${i.text}~~` : i.text).join('\n\n');
          items = [];
        }
        kind = next;
        return;
      }
      const n = await NoteApi.convertNote(noteId, next);
      apply(n);
      kind = n.kind;
      body = n.body_md;
      items = (n.items || []).map(i => ({ ...i }));
    });
    editorKey++;
  }

  async function archive() {
    await flushAll();
    const next = !archived;
    await patch({ archived: next });
    showInfo(next ? $_('notes.toast_archived') : $_('notes.toast_unarchived'));
    close();
  }

  async function trash() {
    await flushAll();
    if (noteId) {
      await enqueue(async () => apply(await NoteApi.trashNote(noteId)));
      showInfo($_('notes.toast_trashed'));
    }
    close(true);
  }

  async function restore() {
    await enqueue(async () => apply(await NoteApi.restoreNote(noteId)));
    showInfo($_('notes.toast_restored'));
  }

  async function deleteForever() {
    const ok = await confirmDialog({
      title: $_('notes.delete_forever_title'),
      message: $_('notes.delete_forever_message'),
      confirmText: $_('notes.delete_forever'),
      dangerous: true,
    });
    if (!ok) return;
    await enqueue(async () => { await NoteApi.deleteNoteForever(noteId); });
    close(true);
  }

  function onRestoredVersion(e) {
    const n = e.detail;
    apply(n);
    title = n.title; body = n.body_md; kind = n.kind;
    items = (n.items || []).map(i => ({ ...i }));
    editorKey++;
    showHistory = false;
  }

  async function flushAll() {
    checklistRef?.flush?.();
    if (textTimer) await saveText();
    await queue;
  }

  let closing = false;
  async function close(skipDiscard = false) {
    if (closing) return;
    closing = true;
    await flushAll();
    // A note that ended up empty is removed instead of lingering as a blank card.
    if (!skipDiscard && noteId && !trashed && isEmptyNote({ title, body_md: body, items })) {
      try { await NoteApi.deleteNoteForever(noteId); } catch { /* best effort */ }
      noteId = null;
    }
    if (touched || skipDiscard) signalNotesChanged();
    refreshLabels();
    dispatch('close', { id: noteId });
  }

  function onKey(e) {
    if (e.key === 'Escape' && !colorOpen && !labelsOpen && !reminderOpen) {
      e.preventDefault();
      if (showHistory) showHistory = false;
      else close();
    }
  }
  function onResize() { narrow = window.innerWidth < 600; }

  onMount(async () => {
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    await tick();
    if (!noteId) {
      if (prefill) scheduleText(); // shared content saves without needing an edit
      else if (kind === 'text') titleEl?.focus();
    }
  });
  onDestroy(() => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    clearTimeout(textTimer);
  });

  function openColor(e) { colorAnchor = e.currentTarget.getBoundingClientRect(); colorOpen = true; }
  function openLabels(e) { labelsAnchor = e.currentTarget.getBoundingClientRect(); labelsOpen = true; }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div use:portal class="editor-backdrop" on:click|self={() => close()} transition:fade={{ duration: 160 }}>
  <div class="editor-panel" class:narrow style={noteColorStyle(color)}
    role="dialog" aria-modal="true" aria-label={title || $_('notes.untitled')}
    in:fly={{ y: narrow ? 30 : 16, duration: 220, easing: cubicOut }}>

    {#if showHistory && noteId}
      <div class="editor-scroll">
        <VersionHistory {noteId} on:close={() => showHistory = false} on:restored={onRestoredVersion} />
      </div>
    {:else}
      <header class="editor-top">
        {#if narrow}
          <button class="icon-btn" on:click={() => close()} aria-label={$_('common.back')}>
            <span class="material-symbols-rounded">arrow_back</span>
          </button>
        {/if}
        <!-- svelte-ignore a11y-autofocus -->
        <input
          class="title-input"
          bind:this={titleEl}
          bind:value={title}
          placeholder={$_('notes.title_placeholder')}
          readonly={readOnly}
          maxlength="1000"
          on:input={scheduleText}
          on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); kind === 'text' ? bodyRef?.focus() : null; } }}
        />
        {#if !readOnly}
          <button class="icon-btn" class:on={pinned} on:click={togglePin}
            title={pinned ? $_('notes.unpin') : $_('notes.pin')} aria-label={pinned ? $_('notes.unpin') : $_('notes.pin')} aria-pressed={pinned}>
            <span class="material-symbols-rounded" class:fill={pinned}>keep</span>
          </button>
        {/if}
      </header>

      <div class="editor-scroll">
        {#key editorKey}
          {#if kind === 'text'}
            <TipTapEditor bind:this={bodyRef} bind:value={body} editable={!readOnly}
              placeholder={$_('notes.body_placeholder')} on:change={scheduleText} />
          {:else}
            <ChecklistEditor bind:this={checklistRef} {items} editable={!readOnly}
              on:add={onItemAdd} on:update={onItemUpdate} on:delete={onItemDelete} on:reorder={onItemReorder} />
          {/if}
        {/key}

        {#if chips.length || reminderAt}
          <div class="editor-chips">
            {#if reminderAt}
              <ReminderChip note={reminderNote} size="md" clickable={!readOnly} removable={!readOnly}
                on:edit={openReminder} on:clear={clearReminder} />
            {/if}
            {#each chips as l (l.id)}
              <span class="chip">
                <span class="chip-dot" style="background:{colorDot(l.color)}"></span>{l.name}
                {#if !readOnly}
                  <button class="chip-x" aria-label={$_('notes.remove_label', { values: { name: l.name } })}
                    on:click={() => setLabels(noteLabels.filter(id => id !== l.id))}>
                    <span class="material-symbols-rounded">close</span>
                  </button>
                {/if}
              </span>
            {/each}
          </div>
        {/if}
      </div>

      <footer class="editor-bar">
        {#if readOnly}
          <span class="edited">{$_('notes.in_trash')}</span>
          <span class="spacer"></span>
          <button class="btn btn-secondary" on:click={restore}>
            <span class="material-symbols-rounded">restore_from_trash</span>{$_('notes.restore')}
          </button>
          <button class="btn btn-danger" on:click={deleteForever}>{$_('notes.delete_forever')}</button>
        {:else}
          <div class="bar-actions">
            <button class="icon-btn" on:click={openReminder} title={$_('reminders.remind_me')} aria-label={$_('reminders.remind_me')}>
              <span class="material-symbols-rounded">notification_add</span>
            </button>
            <button class="icon-btn" on:click={openColor} title={$_('notes.color')} aria-label={$_('notes.color')}>
              <span class="material-symbols-rounded">palette</span>
            </button>
            <button class="icon-btn" on:click={openLabels} title={$_('notes.labels')} aria-label={$_('notes.labels')}>
              <span class="material-symbols-rounded">label</span>
            </button>
            <button class="icon-btn" on:click={convert}
              title={kind === 'text' ? $_('notes.to_checklist') : $_('notes.to_text')}
              aria-label={kind === 'text' ? $_('notes.to_checklist') : $_('notes.to_text')}>
              <span class="material-symbols-rounded">{kind === 'text' ? 'checklist' : 'notes'}</span>
            </button>
            <button class="icon-btn" on:click={archive}
              title={archived ? $_('notes.unarchive') : $_('notes.archive')} aria-label={archived ? $_('notes.unarchive') : $_('notes.archive')}>
              <span class="material-symbols-rounded">{archived ? 'unarchive' : 'archive'}</span>
            </button>
            <button class="icon-btn" on:click={trash} title={$_('notes.move_to_trash')} aria-label={$_('notes.move_to_trash')}>
              <span class="material-symbols-rounded">delete</span>
            </button>
            {#if noteId}
              <button class="icon-btn" on:click={async () => { await flushAll(); showHistory = true; }}
                title={$_('notes.version_history')} aria-label={$_('notes.version_history')}>
                <span class="material-symbols-rounded">history</span>
              </button>
            {/if}
          </div>
          <span class="spacer"></span>
          <span class="edited" aria-live="polite">
            {#if saving}{$_('notes.saving')}{:else if updatedAt}{$_('notes.edited', { values: { when: relativeTime(updatedAt).toLowerCase() } })}{/if}
          </span>
          {#if !narrow}
            <button class="btn btn-primary done" on:click={() => close()}>{$_('notes.done')}</button>
          {/if}
        {/if}
      </footer>
    {/if}
  </div>
</div>

<Popover bind:open={colorOpen} anchor={colorAnchor}>
  <ColorPalette value={color} on:select={(e) => { setColor(e.detail); colorOpen = false; }} />
</Popover>
<Popover bind:open={reminderOpen} anchor={reminderAnchor}>
  <ReminderPicker reminderAt={reminderAt} repeat={reminderRepeat} tz={reminderTz}
    on:set={(e) => setReminder(e.detail)} on:clear={clearReminder} />
</Popover>
<Popover bind:open={labelsOpen} anchor={labelsAnchor}>
  <LabelPicker selected={noteLabels} on:change={(e) => setLabels(e.detail)} />
</Popover>

<style>
  .editor-backdrop {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(20px) saturate(160%);
    -webkit-backdrop-filter: blur(20px) saturate(160%);
    display: flex; align-items: flex-start; justify-content: center;
    padding: max(48px, 7vh) 16px 32px;
  }
  .editor-panel {
    width: 100%; max-width: 760px;
    max-height: calc(100dvh - max(48px, 7vh) - 32px);
    display: flex; flex-direction: column;
    background: var(--note-bg);
    border: 1px solid var(--note-border);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-lg);
    color: var(--text-1);
    overflow: hidden;
  }
  .editor-panel.narrow {
    max-width: none; max-height: none;
    position: fixed; inset: 0;
    border-radius: 0; border: none;
    padding-top: var(--safe-top);
  }
  .editor-top { display: flex; align-items: center; gap: 8px; padding: 22px 20px 4px 32px; }
  .narrow .editor-top { padding: 8px 8px 4px 4px; }
  .title-input {
    flex: 1; min-width: 0;
    background: none; border: none; outline: none;
    font-family: var(--font-note-title);
    font-weight: 500; font-size: 30px; line-height: 1.2; letter-spacing: -0.005em;
    color: var(--text-1);
  }
  .narrow .title-input { font-size: 26px; padding-left: 4px; }
  .title-input::placeholder { color: var(--text-3); }

  .editor-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 32px 20px; display: flex; flex-direction: column; gap: 16px; }
  .narrow .editor-scroll { padding: 8px 20px calc(88px + var(--safe-bottom)); }

  .editor-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip {
    height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 4px 0 11px;
    border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--text-1) 7%, transparent);
    font-size: 13px; font-weight: 500; color: var(--text-2);
  }
  .chip-dot { width: 7px; height: 7px; border-radius: 50%; }
  .chip-x { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
  .chip-x:hover { background: color-mix(in srgb, var(--text-1) 10%, transparent); color: var(--text-1); }
  .chip-x .material-symbols-rounded { font-size: 15px; }

  .editor-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 16px 10px 22px;
    border-top: 1px solid var(--note-border);
  }
  .narrow .editor-bar {
    position: fixed; left: 0; right: 0; bottom: 0;
    padding: 6px 8px calc(6px + var(--safe-bottom));
    background: var(--glass-surface);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
  }
  .bar-actions { display: flex; flex-wrap: wrap; gap: 2px; }
  .spacer { flex: 1; }
  .edited { font-size: 12px; color: var(--text-3); white-space: nowrap; }
  .narrow .edited { display: none; }
  .done { height: 40px; }

  .icon-btn {
    width: 40px; height: 40px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 12px;
    color: var(--text-2);
  }
  .narrow .icon-btn { width: 44px; height: 44px; }
  .icon-btn:hover { background: color-mix(in srgb, var(--text-1) 8%, transparent); color: var(--text-1); }
  .icon-btn.on { color: var(--accent); background: var(--accent-dim); }
  .fill { font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
</style>
