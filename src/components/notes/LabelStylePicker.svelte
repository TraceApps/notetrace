<script>
  /** Color and icon for a label, picked together. */
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import ColorPalette from './ColorPalette.svelte';
  import { LABEL_ICONS } from '../../../server/lib/label-icons.js';
  import { colorDot } from '../../lib/note-colors.js';

  export let color = null;
  export let icon = null;
  const dispatch = createEventDispatcher();
</script>

<div class="lsp">
  <p class="lsp-title">{$_('labels.color_title')}</p>
  <ColorPalette value={color} on:select={(e) => dispatch('color', e.detail)} />
  <p class="lsp-title">{$_('labels.icon_title')}</p>
  <div class="lsp-grid" role="radiogroup" aria-label={$_('labels.icon_title')} style="--glyph:{color ? colorDot(color) : 'var(--text-1)'}">
    <button type="button" class="lsp-icon" class:on={!icon} role="radio" aria-checked={!icon}
      title={$_('labels.no_icon')} aria-label={$_('labels.no_icon')} on:click={() => dispatch('icon', null)}>
      <span class="lsp-dot"></span>
    </button>
    {#each LABEL_ICONS as name (name)}
      <button type="button" class="lsp-icon" class:on={icon === name} role="radio" aria-checked={icon === name}
        aria-label={name.replace(/_/g, ' ')} on:click={() => dispatch('icon', name)}>
        <span class="material-symbols-rounded">{name}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .lsp { display: flex; flex-direction: column; gap: 8px; width: min(340px, calc(100vw - 48px)); padding: 4px; }
  .lsp-title { font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); margin-top: 4px; }
  .lsp-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; max-height: 250px; overflow-y: auto; }
  .lsp-icon {
    aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
    border-radius: 10px; color: var(--text-2);
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .lsp-icon .material-symbols-rounded { font-size: 21px; }
  .lsp-icon:hover { background: color-mix(in srgb, var(--text-1) 8%, transparent); color: var(--text-1); }
  .lsp-icon.on { background: var(--accent-dim); color: var(--glyph); box-shadow: inset 0 0 0 1.5px var(--accent); }
  .lsp-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--glyph); }
</style>
