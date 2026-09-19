<script>
  /** One row of the nested label tree in the sidebar, with its children. */
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import LabelGlyph from '../notes/LabelGlyph.svelte';

  export let node;
  export let activePath = '';
  export let collapsed = [];   // paths folded on this device

  const dispatch = createEventDispatcher();
  $: hasKids = node.children.length > 0;
  $: folded = hasKids && collapsed.includes(node.path.toLowerCase());
  $: active = !!node.label && activePath === `/label/${node.label.id}`;

  function click() {
    if (node.label) dispatch('go', `/label/${node.label.id}`);
    else if (hasKids) dispatch('toggle', node.path.toLowerCase());
  }
</script>

<button class="sidebar-item sidebar-label-item tree-item" class:active class:group={!node.label}
  style="--depth:{node.depth}" on:click={click} title={node.path}>
  {#if hasKids}
    <span class="tree-chevron" role="button" tabindex="-1" aria-label={folded ? $_('sidebar.expand_label') : $_('sidebar.collapse_label')}
      on:click|stopPropagation={() => dispatch('toggle', node.path.toLowerCase())} on:keydown|stopPropagation>
      <span class="material-symbols-rounded" class:folded>expand_more</span>
    </span>
  {:else}
    <span class="label-dot-wrap"><LabelGlyph label={node.label} /></span>
  {/if}
  <span class="sidebar-label">{node.name}</span>
  {#if node.label?.note_count}<span class="label-count">{node.label.note_count}</span>{/if}
  {#if active}<div class="active-indicator"></div>{/if}
</button>
{#if hasKids && !folded}
  {#each node.children as child (child.path)}
    <svelte:self node={child} {activePath} {collapsed} on:go on:toggle />
  {/each}
{/if}
