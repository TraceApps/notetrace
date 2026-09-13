<script>
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { iconUrl } from '../lib/platform.js';
  import { unlockApp, setAuthenticating } from '../lib/app-lock.js';

  let busy = false;
  let failed = false;

  async function unlock() {
    if (busy) return;
    busy = true;
    failed = false;
    setAuthenticating(true);
    try {
      const { authenticateUnlock } = await import('../lib/biometric.js');
      if (await authenticateUnlock($_('app_lock.prompt'))) unlockApp();
      else failed = true;
    } finally {
      setAuthenticating(false);
      busy = false;
    }
  }

  onMount(unlock);
</script>

<div class="lock" role="dialog" aria-modal="true" aria-label={$_('app_lock.locked')} out:fade={{ duration: 180 }}>
  <img class="lock-icon" src={iconUrl('/icons/logo.png')} alt="" />
  <h1>{$_('app_lock.locked')}</h1>
  <p>{failed ? $_('app_lock.try_again') : $_('app_lock.hint')}</p>
  <button class="btn btn-primary" on:click={unlock} disabled={busy}>
    <span class="material-symbols-rounded">fingerprint</span>{$_('app_lock.unlock')}
  </button>
</div>

<style>
  .lock {
    position: fixed; inset: 0; z-index: 10000;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
    padding: 32px;
    background: var(--bg);
    text-align: center;
  }
  .lock-icon { width: 88px; height: 88px; border-radius: 20px; margin-bottom: 8px; }
  h1 { font-family: var(--font-note-title); font-weight: 500; font-size: 26px; }
  p { color: var(--text-2); font-size: 15px; max-width: 280px; }
  .btn { margin-top: 12px; height: 48px; padding: 0 24px; }
</style>
