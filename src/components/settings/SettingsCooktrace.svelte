<script>
  /**
   * SettingsCooktrace: link a CookTrace server so checklist items can go to
   * its shopping list. The token is sent once, checked by the server, and
   * kept there (encrypted); this page only ever sees whether a link exists.
   */
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { cooktraceAvailable, cooktraceLink, loadCooktraceLink, linkCooktrace, unlinkCooktrace } from '../../lib/cooktrace.js';

  let url = '';
  let token = '';
  let busy = false;
  let error = '';

  onMount(() => { loadCooktraceLink({ force: true }); });

  async function link() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await linkCooktrace(url, token);
      token = '';
      showSuccess($_('cooktrace.linked_toast'));
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
    }
  }

  async function unlink() {
    if (!(await confirmDialog({ title: $_('cooktrace.unlink'), message: $_('cooktrace.unlink_confirm'), confirmText: $_('cooktrace.unlink'), cancelText: $_('common.cancel'), dangerous: true }))) return;
    try {
      await unlinkCooktrace();
      showSuccess($_('cooktrace.unlinked'));
    } catch (e) {
      showError(e.message);
    }
  }
</script>

<div class="ct-body">
  {#if !cooktraceAvailable}
    <div class="card settings-card"><p class="note">{$_('cooktrace.needs_server')}</p></div>
  {:else}
    <p class="intro">{$_('cooktrace.intro')}</p>
    <div class="card settings-card">
      {#if $cooktraceLink?.connected}
        <div class="setting-row">
          <div>
            <span class="setting-label"><span class="material-symbols-rounded ok">check_circle</span>{$_('cooktrace.linked')}</span>
            <span class="setting-desc linked-to">
              {$cooktraceLink.username
                ? $_('cooktrace.linked_as', { values: { url: $cooktraceLink.url, user: $cooktraceLink.username } })
                : $_('cooktrace.linked_to', { values: { url: $cooktraceLink.url } })}
            </span>
          </div>
          <button class="btn btn-secondary" on:click={unlink}>{$_('cooktrace.unlink')}</button>
        </div>
      {:else if $cooktraceLink}
        <form class="form-block" on:submit|preventDefault={link}>
          <label class="form-label" for="ct-url">{$_('cooktrace.address')}</label>
          <input id="ct-url" class="input" type="url" inputmode="url" autocomplete="off" placeholder="https://cooktrace.example.com" bind:value={url} />
          <label class="form-label" for="ct-token">{$_('cooktrace.token')}</label>
          <input id="ct-token" class="input" type="password" autocomplete="off" placeholder={$_('cooktrace.token_placeholder')} bind:value={token} />
          {#if error}<p class="error" role="alert">{error}</p>{/if}
          <div class="actions">
            <button class="btn btn-primary" type="submit" disabled={busy || !url.trim() || !token.trim()}>
              {busy ? $_('cooktrace.linking') : $_('cooktrace.link')}
            </button>
          </div>
        </form>
      {/if}
    </div>

    {#if $cooktraceLink && !$cooktraceLink.connected}
      <p class="sub-label">{$_('cooktrace.setup_title')}</p>
      <div class="card settings-card">
        <ol class="steps">
          <li>{$_('cooktrace.setup_1')}</li>
          <li>{$_('cooktrace.setup_2')}</li>
          <li>{$_('cooktrace.setup_3')}</li>
        </ol>
        <p class="note">{$_('cooktrace.setup_private')}</p>
      </div>
    {/if}
  {/if}
</div>

<style>
  .ct-body { display: flex; flex-direction: column; gap: 10px; }
  .intro { font-size: 13px; color: var(--text-2); line-height: 1.5; padding: 0 2px; }
  .sub-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--text-3); padding: 4px 2px 2px; margin: 0;
  }
  .card.settings-card { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
  .setting-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; flex-wrap: wrap; }
  .setting-row > div:first-child { flex: 1 1 200px; min-width: 0; }
  .setting-label { font-size: 14px; color: var(--text-1); display: flex; align-items: center; gap: 6px; font-weight: 500; }
  .setting-desc { font-size: 12px; color: var(--text-3); margin-top: 4px; line-height: 1.4; display: block; }
  .linked-to { overflow-wrap: anywhere; }
  .ok { font-size: 18px; color: var(--success, var(--accent)); }
  .form-block { padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); margin-top: 6px; }
  .input {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 9px 12px; color: var(--text-1); font-size: 14px; box-sizing: border-box; width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .error { color: var(--danger); font-size: 13px; margin-top: 4px; }
  .actions { display: flex; justify-content: flex-end; margin-top: 8px; }
  .steps { margin: 0; padding: 14px 16px 4px 34px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--text-1); line-height: 1.45; }
  .note { font-size: 12px; color: var(--text-3); padding: 8px 16px 14px; line-height: 1.45; }
</style>
