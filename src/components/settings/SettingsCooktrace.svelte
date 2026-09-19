<script>
  /**
   * SettingsCooktrace: link a CookTrace server for its shopping list, laid
   * out like NutriTrace's CookTrace card (status bar, switch, address and
   * token that save when you leave the field). The token goes to this server
   * once, is checked there, and kept encrypted; this page never gets it back,
   * so a saved token shows as dots and typing replaces it.
   */
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { push } from 'svelte-spa-router';
  import Toggle from './Toggle.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import {
    cooktraceAvailable, cooktraceLink, loadCooktraceLink,
    linkCooktrace, testCooktrace, setCooktraceEnabled, unlinkCooktrace,
  } from '../../lib/cooktrace.js';

  let url = '';
  let urlTouched = false;
  let token = '';
  let showToken = false;
  let busy = false;
  let error = '';
  // Switched on before a link exists: show the fields without saving anything yet.
  let localOn = false;

  onMount(() => { loadCooktraceLink({ force: true }); });

  $: link = $cooktraceLink;
  $: if (link?.url && !urlTouched) url = link.url;
  $: enabled = link?.connected ? link.enabled !== false : (link?.enabled === true || localOn);
  $: status = busy ? 'testing' : error ? 'fail' : (link?.connected ? 'ok' : '');

  const same = (a, b) => String(a || '').trim().replace(/\/+$/, '') === String(b || '').trim().replace(/\/+$/, '');

  // Leaving a field while a check runs saves again once it's done, so the
  // last thing typed always gets checked. The same values that just failed
  // aren't sent twice.
  let again = false;
  let lastFailed = '';

  async function save() {
    if (busy) { again = true; return; }
    const u = url.trim();
    const t = token.trim();
    if (!u) return;
    // Nothing new to check: no token yet, or the saved link unchanged.
    if (!t && (!link?.connected || same(u, link.url))) return;
    if (error && lastFailed === `${u}\n${t}`) return;
    busy = true;
    error = '';
    try {
      const saved = await linkCooktrace(u, t);
      token = '';
      showToken = false;
      urlTouched = false;
      lastFailed = '';
      showSuccess(saved.username ? $_('cooktrace.connected_as', { values: { user: saved.username } }) : $_('cooktrace.connected_toast'));
    } catch (e) {
      error = e.message;
      lastFailed = `${u}\n${t}`;
    } finally {
      busy = false;
    }
    if (again) { again = false; save(); }
  }

  async function test() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const saved = await testCooktrace();
      showSuccess(saved.username ? $_('cooktrace.connected_as', { values: { user: saved.username } }) : $_('cooktrace.connected_toast'));
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
    }
  }

  async function toggle(on) {
    error = '';
    localOn = on;
    if (!link?.connected && !link?.enabled) return;
    try {
      await setCooktraceEnabled(on);
    } catch (e) {
      showError(e.message);
    }
  }

  async function unlink() {
    if (!(await confirmDialog({ title: $_('cooktrace.unlink_title'), message: $_('cooktrace.unlink_confirm'), confirmText: $_('cooktrace.unlink'), cancelText: $_('common.cancel'), dangerous: true }))) return;
    try {
      await unlinkCooktrace();
      url = '';
      token = '';
      error = '';
      localOn = true;
      showSuccess($_('cooktrace.unlinked'));
    } catch (e) {
      showError(e.message);
    }
  }
</script>

<div class="section-body">
  {#if !cooktraceAvailable}
    <div class="card settings-card"><p class="note">{$_('cooktrace.needs_server')}</p></div>
  {:else if link}
    <p class="settings-group-heading">{$_('cooktrace.heading')}</p>
    <p class="settings-group-sub">{$_('cooktrace.intro')}</p>
    <div class="card settings-card">
      {#if enabled}
        <ConnectionStatus
          {status}
          okLabel={$_('cooktrace.connected')}
          connectedAs={link.username || ''}
          error={error}
          onRetest={link.connected ? test : null}
          retestDisabled={busy}
          retestLabel={$_('cooktrace.test')}
          testingLabel={$_('cooktrace.testing')}
        />
      {/if}
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('cooktrace.enable')}</span>
          <span class="setting-desc">{$_('cooktrace.enable_desc')}</span>
        </div>
        <Toggle label={$_('cooktrace.enable')} checked={enabled} on:change={e => toggle(e.detail)} />
      </div>

      {#if enabled}
        <div class="setting-divider"></div>
        <div class="form-group" style="padding:10px 16px">
          <label class="form-label" for="ct-url">{$_('cooktrace.address')}</label>
          <input id="ct-url" class="input" type="url" inputmode="url" autocomplete="off"
            placeholder="https://cooktrace.example.com"
            bind:value={url} on:input={() => urlTouched = true} on:blur={save} />
          <span class="setting-desc">{$_('cooktrace.setup_private')}</span>
        </div>
        <div class="setting-divider"></div>
        <div class="form-group" style="padding:10px 16px">
          <label class="form-label" for="ct-token">{$_('cooktrace.token')}</label>
          <div class="token-row">
            <input id="ct-token" class="input" type={showToken ? 'text' : 'password'} autocomplete="off"
              placeholder={link.connected ? '••••••••••••••••••••••••••••••••' : 'ct_pat_...'}
              bind:value={token} on:blur={save} />
            <button type="button" class="btn-icon" on:click={() => showToken = !showToken} disabled={!token}
              title={showToken ? $_('cooktrace.hide') : $_('cooktrace.show')} aria-label={showToken ? $_('cooktrace.hide') : $_('cooktrace.show')}>
              <span class="material-symbols-rounded">{showToken ? 'visibility_off' : 'visibility'}</span>
            </button>
          </div>
          <span class="setting-desc">{link.connected ? $_('cooktrace.token_saved') : $_('cooktrace.token_help')}</span>
        </div>

        {#if link.connected}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">{$_('cooktrace.open_label')}</span>
              <span class="setting-desc">{$_('cooktrace.open_desc')}</span>
            </div>
            <button class="btn btn-primary" on:click={() => push('/shopping')}>
              <span class="material-symbols-rounded">shopping_cart</span>{$_('cooktrace.open')}
            </button>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">{$_('cooktrace.unlink_label')}</span>
              <span class="setting-desc">{$_('cooktrace.unlink_desc')}</span>
            </div>
            <button class="btn btn-secondary" on:click={unlink}>{$_('cooktrace.unlink')}</button>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .section-body { display: flex; flex-direction: column; }
  .card.settings-card { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }
  .input {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 9px 12px; color: var(--text-1); font-size: 14px; box-sizing: border-box; width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .token-row { display: flex; gap: 8px; align-items: center; }
  .token-row .input { flex: 1; min-width: 0; }
  .btn .material-symbols-rounded { font-size: 18px; }
  .note { font-size: 12px; color: var(--text-3); padding: 14px 16px; line-height: 1.45; }
</style>
