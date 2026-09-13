<script>
  import { _ } from 'svelte-i18n';
  import { bannerStyle } from '../stores/settings.js';
</script>

<div class="page-shell">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.notes.title')}</h1>
  </header>

  <div class="page-content notes-content">
    <div class="notes-empty">
      <span class="material-symbols-rounded notes-empty-icon">sticky_note_2</span>
      <h2>{$_('routes.notes.empty_title')}</h2>
      <p>{$_('routes.notes.empty_body')}</p>
    </div>
  </div>
</div>

<style>
  .notes-content {
    display: flex;
    justify-content: center;
    padding: var(--space-8) var(--page-px);
  }
  .notes-empty {
    max-width: 360px;
    margin-top: 12vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    text-align: center;
  }
  .notes-empty-icon {
    font-size: 48px;
    color: var(--accent);
    margin-bottom: var(--space-2);
  }
  .notes-empty h2 {
    font-family: var(--font-note-title);
    font-weight: 500;
    font-size: 24px;
    letter-spacing: -0.005em;
  }
  .notes-empty p {
    color: var(--text-2);
    font-size: 15px;
    line-height: 1.5;
  }
</style>
