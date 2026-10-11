<script>
  import { onMount, onDestroy } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import NoteCard from './NoteCard.svelte';
  import { cardDrag } from '../../lib/card-drag.js';
  import { cardSwipe } from '../../lib/card-swipe.js';
  import { moveId } from '../../lib/note-order.js';
  import { cardDensity } from '../../stores/settings.js';
  import { fold } from '../../lib/fold.js';
  import { columnsAcrossFold } from '../../lib/fold-core.js';

  export let notes = [];
  export let view = 'notes';
  export let selectedIds = new Set();
  export let selecting = false;
  /** Cards can be dragged into a new order (dispatches `reorder` with the note ids). */
  export let draggable = false;
  /** Touch swipe sideways (dispatches `swipe` with { id, dir }). */
  export let swipeable = false;
  export let terms = [];
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
  // The grid's own x on screen: a fold is reported in screen coordinates and
  // this grid may sit beside a pinned sidebar.
  let left = 0;
  let ro;
  const GAP = 16;
  $: compact = $cardDensity === 'compact';
  $: CARD_MAX = compact ? 240 : 300;

  $: minCard = width < 560 ? (compact ? 130 : 150) : (compact ? 190 : 236);
  $: gap = width < 560 ? (compact ? 8 : 10) : (compact ? 10 : GAP);
  // A cover screen narrower than about 360px gets one column; two would squeeze titles onto three lines.
  $: plainColumns = width > 0 && width < 330 ? 1 : Math.max(1, Math.min(6, Math.floor((width + gap) / (minCard + gap)) || 1));
  // Half open like a book, the cards are dealt either side of the crease
  // rather than across it, with the hinge as an empty track between them.
  $: across = columnsAcrossFold({ width, left, gap, minCard, fold: $fold });
  $: columns = across ? across.left + across.right : plainColumns;
  $: template = across
    ? `repeat(${across.left}, minmax(0, 1fr)) ${across.hinge}px repeat(${across.right}, minmax(0, 1fr))`
    : `repeat(${columns}, minmax(0, ${width < 560 ? '1fr' : CARD_MAX + 'px'}))`;
  $: cols = deal(notes, columns);

  // Each card keeps its list position so the entrance can ripple in order.
  function deal(list, n) {
    const out = Array.from({ length: n }, () => []);
    list.forEach((note, i) => out[i % n].push({ note, i }));
    return out;
  }

  function measure() {
    const box = el?.getBoundingClientRect();
    width = box?.width || 0;
    left = box?.left || 0;
  }

  onMount(() => {
    measure();
    ro = new ResizeObserver(() => measure());
    ro.observe(el);
  });
  // Half opening a foldable moves the crease without resizing this grid.
  $: if ($fold !== undefined && el) measure();
  onDestroy(() => ro?.disconnect());
</script>

<div class="note-grid" class:across-fold={!!across} bind:this={el} use:cardDrag={{ enabled: draggable, onDrop }} use:cardSwipe={{ enabled: swipeable, onSwipe: (id, dir) => dispatch('swipe', { id, dir }) }} style="--gap:{gap}px; --template:{template}">
  {#each cols as col, ci (ci)}
    {#if across && ci === across.left}<div class="hinge-gap" aria-hidden="true"></div>{/if}
    <div class="note-col">
      {#each col as { note, i } (note.id)}
        <NoteCard {note} {view} {terms} index={i} selected={selectedIds.has(note.id)} {selecting} on:open on:action on:toggleItem on:select />
      {/each}
    </div>
  {/each}
</div>

<style>
  .note-grid {
    display: grid;
    grid-template-columns: var(--template);
    justify-content: center;
    gap: var(--gap);
    align-items: start;
  }
  /* Either side of a crease the columns fill their own panel, so nothing is
     centred across the fold. The hinge track carries no gap of its own: the
     crease is the gap. */
  .note-grid.across-fold { justify-content: stretch; column-gap: 0; }
  .note-grid.across-fold .note-col { margin: 0 calc(var(--gap) / 2); }
  .hinge-gap { pointer-events: none; }
  .note-col { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
</style>
