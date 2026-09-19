<script>
  /** A label's mark: its icon in the label's color, or a colored dot. */
  import { colorDot } from '../../lib/note-colors.js';

  export let label = null;
  export let size = 8;       // dot diameter
  export let iconSize = 18;
</script>

{#if label?.icon}
  <span class="material-symbols-rounded label-glyph" aria-hidden="true"
    style="font-size:{iconSize}px; color:{label.color ? colorDot(label.color) : 'currentColor'}">{label.icon}</span>
{:else}
  <span class="label-glyph-dot" aria-hidden="true" style="width:{size}px; height:{size}px; background:{label ? colorDot(label.color) : 'var(--text-3)'}"></span>
{/if}

<style>
  .label-glyph { line-height: 1; flex-shrink: 0; }
  .label-glyph-dot { border-radius: 50%; flex-shrink: 0; display: inline-block; }
</style>
