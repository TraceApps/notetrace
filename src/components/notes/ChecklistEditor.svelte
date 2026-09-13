<script>
  /**
   * ChecklistEditor: edit a checklist note's items in place.
   *
   * Owns a local copy of the items while the editor is open and emits one
   * operation per change (add / update / delete / reorder), so every
   * change touches a single item row and syncs without replacing the list.
   * New items get their uuid here, so focus can move to them before the
   * save round-trip finishes.
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { dragHandleZone, dragHandle } from 'svelte-dnd-action';

  export let items = [];
  export let editable = true;

  const dispatch = createEventDispatcher();
  const FLIP_MS = 160;
  const TEXT_SAVE_MS = 500;

  let list = items.map(i => ({ ...i, id: i.uuid }));
  let showChecked = true;
  let newText = '';
  let inputs = {};
  let textTimers = {};

  $: open = list.filter(i => !i.checked);
  $: done = list.filter(i => i.checked);

  function uuid() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function positionAfter(uuidBefore) {
    const idx = list.findIndex(i => i.uuid === uuidBefore);
    const before = list[idx]?.position ?? 0;
    const after = list.slice(idx + 1).find(i => !i.checked)?.position;
    return after != null ? (before + after) / 2 : before + 1;
  }

  function autosize(node) {
    const fit = () => { node.style.height = 'auto'; node.style.height = node.scrollHeight + 'px'; };
    fit();
    node.addEventListener('input', fit);
    return { update: fit, destroy: () => node.removeEventListener('input', fit) };
  }

  async function focusItem(u, atEnd = true) {
    await tick();
    const node = inputs[u];
    if (!node) return;
    node.focus();
    const pos = atEnd ? node.value.length : 0;
    node.setSelectionRange(pos, pos);
  }

  function flushText(u) {
    clearTimeout(textTimers[u]);
    delete textTimers[u];
    const item = list.find(i => i.uuid === u);
    if (item) dispatch('update', { uuid: u, patch: { text: item.text } });
  }

  function onText(item) {
    clearTimeout(textTimers[item.uuid]);
    textTimers[item.uuid] = setTimeout(() => flushText(item.uuid), TEXT_SAVE_MS);
  }

  /** Flush pending text saves (called by the parent before it closes). */
  export function flush() {
    for (const u of Object.keys(textTimers)) flushText(u);
  }

  function toggle(item) {
    if (!editable) return;
    list = list.map(i => i.uuid === item.uuid ? { ...i, checked: !i.checked } : i);
    dispatch('update', { uuid: item.uuid, patch: { checked: !item.checked } });
  }

  async function addAfter(item) {
    const position = positionAfter(item.uuid);
    const fresh = { uuid: uuid(), id: null, text: '', checked: false, position };
    fresh.id = fresh.uuid;
    const idx = list.findIndex(i => i.uuid === item.uuid);
    list = [...list.slice(0, idx + 1), fresh, ...list.slice(idx + 1)];
    dispatch('add', { uuid: fresh.uuid, text: '', position });
    focusItem(fresh.uuid);
  }

  function remove(item, focusPrev = false) {
    const openIdx = open.findIndex(i => i.uuid === item.uuid);
    const prev = openIdx > 0 ? open[openIdx - 1] : null;
    clearTimeout(textTimers[item.uuid]);
    delete textTimers[item.uuid];
    list = list.filter(i => i.uuid !== item.uuid);
    dispatch('delete', { uuid: item.uuid });
    if (focusPrev && prev) focusItem(prev.uuid);
  }

  function onKeydown(e, item) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      flushText(item.uuid);
      addAfter(item);
    } else if (e.key === 'Backspace' && item.text === '') {
      e.preventDefault();
      remove(item, true);
    }
  }

  function addFromNewRow() {
    const text = newText.trim();
    if (!text) return;
    const last = open[open.length - 1];
    const position = (last?.position ?? 0) + 1;
    const fresh = { uuid: uuid(), text, checked: false, position };
    fresh.id = fresh.uuid;
    list = [...list, fresh];
    newText = '';
    dispatch('add', { uuid: fresh.uuid, text, position });
  }

  function onNewKeydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); addFromNewRow(); }
  }

  // Drag reorder applies to open items only; checked items keep their
  // place in the collapsed section below.
  function onConsider(e) {
    list = [...e.detail.items, ...done];
  }
  function onFinalize(e) {
    const reordered = e.detail.items.map((it, i) => ({ ...it, position: i + 1 }));
    list = [...reordered, ...done];
    dispatch('reorder', { uuids: reordered.map(i => i.uuid) });
  }
</script>

<div class="checklist">
  <ul class="items"
    use:dragHandleZone={{ items: open, flipDurationMs: FLIP_MS, dropTargetStyle: {}, type: 'checklist', dragDisabled: !editable }}
    on:consider={onConsider}
    on:finalize={onFinalize}>
    {#each open as item (item.id)}
      <li class="item">
        {#if editable}
          <span class="handle" use:dragHandle aria-label={$_('notes.drag_to_reorder')}>
            <span class="material-symbols-rounded">drag_indicator</span>
          </span>
        {/if}
        <button type="button" class="check" aria-label={$_('notes.check_item')} on:click={() => toggle(item)}></button>
        <textarea
          class="item-text"
          rows="1"
          bind:this={inputs[item.uuid]}
          bind:value={item.text}
          readonly={!editable}
          use:autosize={item.text}
          on:input={() => onText(item)}
          on:keydown={(e) => onKeydown(e, item)}
          on:blur={() => textTimers[item.uuid] && flushText(item.uuid)}
        ></textarea>
        {#if editable}
          <button type="button" class="remove" aria-label={$_('notes.remove_item')} on:click={() => remove(item)}>
            <span class="material-symbols-rounded">close</span>
          </button>
        {/if}
      </li>
    {/each}
  </ul>

  {#if editable}
    <div class="item add-row">
      <span class="material-symbols-rounded add-icon">add</span>
      <input class="item-text" placeholder={$_('notes.list_item')} bind:value={newText}
        on:keydown={onNewKeydown} on:blur={addFromNewRow} />
    </div>
  {/if}

  {#if done.length}
    <button type="button" class="checked-toggle" on:click={() => showChecked = !showChecked} aria-expanded={showChecked}>
      <span class="material-symbols-rounded chevron" class:collapsed={!showChecked}>expand_more</span>
      {$_('notes.checked_items', { values: { count: done.length } })}
    </button>
    {#if showChecked}
      <ul class="items" transition:slide={{ duration: 160 }}>
        {#each done as item (item.uuid)}
          <li class="item done">
            <button type="button" class="check on" aria-label={$_('notes.uncheck_item')} on:click={() => toggle(item)}>
              <span class="material-symbols-rounded">check</span>
            </button>
            <span class="item-text static">{item.text}</span>
            {#if editable}
              <button type="button" class="remove" aria-label={$_('notes.remove_item')} on:click={() => remove(item)}>
                <span class="material-symbols-rounded">close</span>
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .checklist { display: flex; flex-direction: column; }
  .items { list-style: none; display: flex; flex-direction: column; }
  .item {
    display: flex; align-items: flex-start; gap: 10px;
    min-height: 40px;
    padding: 4px 0;
    border-radius: 10px;
  }
  .handle {
    width: 22px; margin-left: -8px; padding-top: 7px;
    color: var(--text-3);
    cursor: grab;
    opacity: 0;
    transition: opacity var(--dur-fast);
    touch-action: none;
  }
  .handle .material-symbols-rounded { font-size: 18px; }
  .item:hover .handle, .item:focus-within .handle { opacity: 1; }
  @media (hover: none) { .handle { opacity: 0.6; } }

  .check {
    width: 20px; height: 20px; margin-top: 7px; flex-shrink: 0;
    border-radius: 6px;
    border: 1.5px solid var(--text-3);
    display: flex; align-items: center; justify-content: center;
  }
  .check:hover { border-color: var(--accent); }
  .check.on { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  .check.on .material-symbols-rounded { font-size: 16px; font-variation-settings: 'FILL' 0, 'wght' 700, 'GRAD' 0, 'opsz' 20; }

  .item-text {
    flex: 1; min-width: 0;
    background: none; border: none; resize: none; outline: none;
    color: color-mix(in srgb, var(--text-1) 90%, transparent);
    font: inherit; font-size: 16px; line-height: 1.5;
    padding: 5px 0;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .item-text::placeholder { color: var(--text-3); }
  .static { white-space: pre-wrap; }

  .remove {
    width: 32px; height: 32px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 9px;
    color: var(--text-3);
    opacity: 0;
  }
  .remove .material-symbols-rounded { font-size: 18px; }
  .item:hover .remove, .item:focus-within .remove { opacity: 1; }
  .remove:hover { color: var(--text-1); background: color-mix(in srgb, var(--text-1) 8%, transparent); }
  @media (hover: none) { .remove { opacity: 0.7; } }

  .add-row { color: var(--text-3); padding-left: 14px; }
  .add-icon { font-size: 20px; margin-top: 7px; margin-right: 1px; }

  .done .item-text { color: var(--text-3); text-decoration: line-through; }
  .done { padding-left: 14px; }

  .checked-toggle {
    display: flex; align-items: center; gap: 6px;
    margin-top: 8px; padding: 10px 0 6px;
    border-top: 1px solid var(--border);
    color: var(--text-2);
    font-size: 14px; font-weight: 500;
    text-align: left;
  }
  .chevron { font-size: 20px; transition: transform var(--dur-fast); }
  .chevron.collapsed { transform: rotate(-90deg); }
</style>
