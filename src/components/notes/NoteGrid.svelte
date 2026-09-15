<script>
  import { onMount, onDestroy } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import NoteCard from './NoteCard.svelte';
  import { cardDrag } from '../../lib/card-drag.js';
  import { moveId } from '../../lib/note-order.js';

  export let notes = [];
  export let view = 'notes';
  export let selectedIds = new Set();
  export let selecting = false;
  /** Cards can be dragged into a new order (dispatches `reorder` with the note ids). */
  export let draggable = false;
  const dispatch = createEventDispatcher();
  function onDrop(dragId, targetId, after) {
    const ids = moveId(notes.map(n => n.id), dragId, targetId, after);
    if (ids.join() !== notes.map(n => n.id).join()) dispatch('reorder', { ids });
  }

  // Column count follows the grid's own width (not the viewport), so it
  // stays right beside a pinned sidebar. Cards are dealt out row by row,
  // which keeps reading order left to right like the source list.
  let el;
  let width = 0;
  let ro;
  const GAP = 16;
  const CARD_MAX = 300;

  $: minCard = width < 560 ? 150 : 236;
  $: gap = width < 560 ? 10 : GAP;
  $: columns = Math.max(1, Math.min(6, Math.floor((width + gap) / (minCard + gap)) || 1));
  $: cols = deal(notes, columns);

  // Each card keeps its list position so the entrance can ripple in order.
  function deal(list, n) {
    const out = Array.from({ length: n }, () => []);
    list.forEach((note, i) => out[i % n].push({ note, i }));
    return out;
  }

  onMount(() => {
    width = el?.clientWidth || 0;
    ro = new ResizeObserver(entries => { width = entries[0].contentRect.width; });
    ro.observe(el);
  });
  onDestroy(() => ro?.disconnect());
</script>

<div class="note-grid" bind:this={el} use:cardDrag={{ enabled: draggable, onDrop }} style="--cols:{columns}; --gap:{gap}px; --card-max:{width < 560 ? '1fr' : CARD_MAX + 'px'}">
  {#each cols as col, ci (ci)}
    <div class="note-col">
      {#each col as { note, i } (note.id)}
        <NoteCard {note} {view} index={i} selected={selectedIds.has(note.id)} {selecting} on:open on:action on:toggleItem on:menu on:select />
      {/each}
    </div>
  {/each}
</div>

<style>
  .note-grid {
    display: grid;
    grid-template-columns: repeat(var(--cols), minmax(0, var(--card-max)));
    justify-content: center;
    gap: var(--gap);
    align-items: start;
  }
  .note-col { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
</style>
