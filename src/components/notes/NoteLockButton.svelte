<script>
  import { _ } from 'svelte-i18n';
  export let locked = false;
  export let disabled = false;
</script>

<button type="button" class="icon-btn" class:on={locked} {disabled} on:click
  aria-pressed={locked} aria-label={$_(locked ? 'notes.unlock_note' : 'notes.lock_note')}
  title={$_(locked ? 'notes.unlock_note' : 'notes.lock_note')}>
  <span class="material-symbols-rounded">{locked ? 'lock' : 'lock_open'}</span>
</button>
