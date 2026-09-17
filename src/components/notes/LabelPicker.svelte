<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { NoteApi } from '../../lib/api.js';
  import { labels, refreshLabels } from '../../stores/notes.js';
  import LabelGlyph from './LabelGlyph.svelte';
  import { buildLabelTree, flattenTree } from '../../lib/label-tree.js';
  import { showError } from '../../stores/toast.js';

  /** Label ids currently on the note. */
  export let selected = [];
  const dispatch = createEventDispatcher();

  let query = '';
  let busy = false;
  // With a keyboard and mouse, typing searches straight away. On a touch
  // screen the keyboard would cover the labels, so it waits for a tap on Search.
  const typeFirst = typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

  $: q = query.trim().toLowerCase();
  // Nested labels ("Home/Garage") list under their parent, indented.
  // A group that isn't a label itself ("DockerCompose" in "DockerCompose/YAML")
  // shows as a heading, so its labels aren't left without a name above them.
  $: ordered = flattenTree(buildLabelTree($labels)).map(n => n.label
    ? { ...n.label, _key: n.label.id, _depth: n.depth, _short: n.name }
    : { _key: `group:${n.path}`, _group: true, _depth: n.depth, _short: n.name });
  $: filtered = q ? $labels.filter(l => l.name.toLowerCase().includes(q)).map(l => ({ ...l, _key: l.id, _depth: 0, _short: l.name })) : ordered;
  $: exact = $labels.some(l => l.name.toLowerCase() === q);

  function toggle(id) {
    const next = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id];
    dispatch('change', next);
  }

  async function create() {
    const name = query.trim();
    if (!name || exact || busy) return;
    busy = true;
    try {
      const label = await NoteApi.createLabel({ name });
      await refreshLabels();
      query = '';
      if (label?.id) dispatch('change', [...selected, label.id]);
    } catch (e) {
      showError(e.message || $_('notes.label_create_failed'));
    } finally {
      busy = false;
    }
  }

  function onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!exact && q) create();
      else if (filtered.length === 1 && !filtered[0]._group) toggle(filtered[0].id);
    }
  }
</script>

<div class="label-picker" tabindex="-1" data-autofocus={typeFirst ? undefined : ''}>
  <p class="lp-title">{$_('notes.label_note')}</p>
  <div class="lp-search">
    <span class="material-symbols-rounded">search</span>
    <input data-autofocus={typeFirst ? '' : undefined} placeholder={$_('notes.label_search')} aria-label={$_('notes.label_search')}
      bind:value={query} on:keydown={onKey} enterkeyhint="done" />
  </div>
  <ul class="lp-list">
    {#each filtered as l (l._key)}
      {#if l._group}
      <li class="lp-group" style="padding-left:{l._depth * 14 + 6}px">
        <span class="material-symbols-rounded">folder</span>
        <span class="lp-name" title={l._short}>{l._short}</span>
      </li>
      {:else}
      <li>
        <label class="lp-row">
          <input type="checkbox" checked={selected.includes(l.id)} on:change={() => toggle(l.id)} />
          <span class="lp-dot"><LabelGlyph label={l} iconSize={17} /></span>
          <span class="lp-name" style="padding-left:{l._depth * 14}px" title={l.name}>{l._short}</span>
        </label>
      </li>
      {/if}
    {/each}
  </ul>
  {#if q && !exact}
    <button type="button" class="lp-create" on:click={create} disabled={busy}>
      <span class="material-symbols-rounded">add</span>
      {$_('notes.label_create', { values: { name: query.trim() } })}
    </button>
  {:else if !$labels.length}
    <p class="lp-empty">{$_('notes.label_none_yet')}</p>
  {/if}
</div>

<style>
  .label-picker { display: flex; flex-direction: column; gap: 8px; width: 260px; max-width: 100%; outline: none; }
  .lp-title { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .lp-search {
    display: flex; align-items: center; gap: 8px;
    height: 38px; padding: 0 10px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px;
    color: var(--text-3);
  }
  .lp-search .material-symbols-rounded { font-size: 18px; }
  .lp-search input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--text-1); font-size: 14px; }
  /* Room the popover has (above a keyboard, say), less the title and search. */
  .lp-list {
    list-style: none; margin: 0 -6px;
    max-height: max(120px, min(320px, calc(var(--pop-avail, 100dvh) - 170px)));
    overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
  }
  .lp-row {
    display: flex; align-items: center; gap: 10px;
    min-height: 40px; padding: 0 6px;
    border-radius: 8px; cursor: pointer;
    font-size: 14px;
  }
  .lp-row:hover { background: color-mix(in srgb, var(--text-1) 6%, transparent); }
  .lp-row input { accent-color: var(--accent); width: 16px; height: 16px; }
  .lp-group {
    display: flex; align-items: center; gap: 8px; min-height: 32px; padding-right: 6px;
    font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: var(--text-3);
  }
  .lp-group .material-symbols-rounded { font-size: 17px; }
  .lp-dot { width: 18px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .lp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lp-create {
    display: flex; align-items: center; gap: 8px;
    min-height: 40px; padding: 0 6px;
    border-radius: 8px;
    color: var(--accent); font-size: 14px; font-weight: 500; text-align: left;
  }
  .lp-create:hover { background: var(--accent-dim); }
  .lp-create .material-symbols-rounded { font-size: 19px; }
  .lp-empty { font-size: 13px; color: var(--text-3); padding: 4px 0; }
</style>
