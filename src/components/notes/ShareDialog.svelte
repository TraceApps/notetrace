<script>
  /**
   * ShareDialog: who a note is shared with.
   * The owner adds people by username or email, picks view or edit, and
   * removes them. A member sees the list and can leave.
   * The owner can also make a public link: read-only, no account needed.
   */
  import { onMount, createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { NoteApi } from '../../lib/api.js';
  import { currentUser } from '../../stores/auth.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { showError, showInfo } from '../../stores/toast.js';
  import { syncAfterShareChange, serverNoteId } from '../../lib/note-sharing.js';
  import { isNative, publicNoteUrl } from '../../lib/platform.js';

  export let noteId;

  const dispatch = createEventDispatcher();
  let loading = true;
  let data = null;
  let people = [];
  let who = '';
  let role = 'edit';
  let busy = false;
  // The server's id for this note (differs from noteId on Android).
  let sid = null;
  let publicToken = null;
  let linkBusy = false;
  let copied = false;
  // The system share sheet: the Android app, and phone browsers that have one.
  const canSend = isNative || (typeof navigator !== 'undefined' && typeof navigator.share === 'function');

  $: owner = data?.role === 'owner';
  $: memberIds = new Set((data?.members || []).map(m => m.user_id));
  $: suggestions = people.filter(p => !memberIds.has(p.id));
  $: publicUrl = publicToken ? publicNoteUrl(publicToken) : '';
  const nameOf = (p) => p?.full_name || p?.username || '';
  const initial = (p) => (nameOf(p)[0] || '?').toUpperCase();

  async function load() {
    try {
      sid = await serverNoteId(noteId);
      if (sid == null) throw new Error($_('sharing.not_synced'));
      data = await NoteApi.getMembers(sid);
      if (data.role === 'owner') {
        publicToken = (await NoteApi.getPublicLink(sid).catch(() => null))?.token || null;
        if (!people.length) people = await NoteApi.getUsersList().catch(() => []);
      }
    } catch (e) {
      showError(e.message || $_('sharing.load_failed'));
    } finally {
      loading = false;
    }
  }

  async function changed(next) {
    data = next;
    dispatch('changed', { count: next.members?.length || 0 });
    await syncAfterShareChange();
  }

  async function add() {
    const name = who.trim();
    if (!name || busy) return;
    busy = true;
    try {
      const r = await NoteApi.addMember(sid, { username: name, role });
      who = '';
      await changed(r);
    } catch (e) {
      showError(e.message || $_('sharing.add_failed'));
    } finally {
      busy = false;
    }
  }

  async function setRole(m, next) {
    try { await changed(await NoteApi.updateMember(sid, m.user_id, { role: next })); }
    catch (e) { showError(e.message); }
  }

  async function remove(m) {
    try { await changed(await NoteApi.removeMember(sid, m.user_id)); }
    catch (e) { showError(e.message); }
  }

  async function leave() {
    const ok = await confirmDialog({
      title: $_('sharing.leave_title'),
      message: $_('sharing.leave_message', { values: { name: nameOf(data?.owner) } }),
      confirmText: $_('sharing.leave'),
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NoteApi.removeMember(sid, $currentUser?.id);
      showInfo($_('sharing.left'));
      await syncAfterShareChange();
      dispatch('left');
    } catch (e) {
      showError(e.message);
    }
  }

  async function createLink() {
    if (linkBusy) return;
    linkBusy = true;
    try {
      publicToken = (await NoteApi.createPublicLink(sid)).token;
      // Copied for you when the browser allows it this long after the tap;
      // the link and its Copy button are on screen either way.
      await copyLink({ quiet: true });
    } catch (e) {
      showError(e.message || $_('sharing.link_failed'));
    } finally {
      linkBusy = false;
    }
  }

  async function copyLink({ quiet = false } = {}) {
    try {
      await navigator.clipboard.writeText(publicUrl);
      copied = true;
      setTimeout(() => copied = false, 1500);
    } catch {
      if (!quiet) showError($_('sharing.copy_failed'));
    }
  }

  async function sendLink() {
    try {
      if (isNative) {
        const { Share } = await import('@capacitor/share');
        await Share.share({ url: publicUrl });
      } else {
        await navigator.share({ url: publicUrl });
      }
    } catch { /* closed the sheet */ }
  }

  async function openLink() {
    if (isNative) {
      const { Browser } = await import('@capacitor/browser');
      Browser.open({ url: publicUrl }).catch(() => {});
    } else {
      window.open(publicUrl, '_blank', 'noopener');
    }
  }

  async function removeLink() {
    const ok = await confirmDialog({
      title: $_('sharing.link_remove_title'),
      message: $_('sharing.link_remove_message'),
      confirmText: $_('sharing.link_remove'),
      dangerous: true,
    });
    if (!ok) return;
    linkBusy = true;
    try {
      await NoteApi.removePublicLink(sid);
      publicToken = null;
      showInfo($_('sharing.link_removed'));
    } catch (e) {
      showError(e.message || $_('sharing.link_failed'));
    } finally {
      linkBusy = false;
    }
  }

  onMount(load);
</script>

<div class="sd">
  <p class="sd-title">{$_('sharing.title')}</p>

  {#if loading}
    <p class="sd-muted">{$_('common.loading')}</p>
  {:else if data}
    <ul class="sd-list">
      {#if data.owner}
        <li class="sd-row">
          <span class="sd-avatar">{initial(data.owner)}</span>
          <span class="sd-name">
            <span>{nameOf(data.owner)}{#if data.owner.user_id === $currentUser?.id}<span class="sd-you"> {$_('sharing.you')}</span>{/if}</span>
            <span class="sd-sub">{$_('sharing.owner')}</span>
          </span>
        </li>
      {/if}
      {#each data.members as m (m.user_id)}
        <li class="sd-row">
          <span class="sd-avatar">{initial(m)}</span>
          <span class="sd-name">
            <span>{nameOf(m)}{#if m.user_id === $currentUser?.id}<span class="sd-you"> {$_('sharing.you')}</span>{/if}</span>
            <span class="sd-sub">@{m.username}</span>
          </span>
          {#if owner}
            <select class="sd-role" value={m.role} on:change={(e) => setRole(m, e.target.value)} aria-label={$_('sharing.access')}>
              <option value="edit">{$_('sharing.can_edit')}</option>
              <option value="view">{$_('sharing.can_view')}</option>
            </select>
            <button class="sd-x" on:click={() => remove(m)} aria-label={$_('sharing.remove', { values: { name: nameOf(m) } })}>
              <span class="material-symbols-rounded">close</span>
            </button>
          {:else}
            <span class="sd-sub sd-role-text">{m.role === 'view' ? $_('sharing.can_view') : $_('sharing.can_edit')}</span>
          {/if}
        </li>
      {/each}
    </ul>

    {#if owner}
      <form class="sd-add" on:submit|preventDefault={add}>
        <span class="material-symbols-rounded">person_add</span>
        <input class="sd-input" bind:value={who} list="share-people-{noteId}" autocomplete="off"
          autocapitalize="none" spellcheck="false"
          placeholder={$_('sharing.add_placeholder')} aria-label={$_('sharing.add_placeholder')} />
        <datalist id="share-people-{noteId}">
          {#each suggestions as p (p.id)}<option value={p.username}>{p.name}</option>{/each}
        </datalist>
        <select class="sd-role" bind:value={role} aria-label={$_('sharing.access')}>
          <option value="edit">{$_('sharing.can_edit')}</option>
          <option value="view">{$_('sharing.can_view')}</option>
        </select>
        <button class="btn btn-primary sd-go" type="submit" disabled={!who.trim() || busy}>{$_('sharing.add')}</button>
      </form>
      <p class="sd-muted">{$_('sharing.owner_hint')}</p>

      <div class="sd-public">
        <p class="sd-title">{$_('sharing.link_title')}</p>
        {#if publicToken}
          <div class="sd-link">
            <span class="material-symbols-rounded">public</span>
            <input class="sd-input" value={publicUrl} readonly aria-label={$_('sharing.link_title')}
              on:focus={(e) => e.currentTarget.select()} />
            <button class="sd-x" on:click={openLink} title={$_('sharing.link_open')} aria-label={$_('sharing.link_open')}>
              <span class="material-symbols-rounded">open_in_new</span>
            </button>
            {#if canSend}
              <button class="sd-x" on:click={sendLink} title={$_('sharing.link_send')} aria-label={$_('sharing.link_send')}>
                <span class="material-symbols-rounded">share</span>
              </button>
            {/if}
            <button class="btn btn-primary sd-go" on:click={() => copyLink()}>{copied ? $_('sharing.link_copied') : $_('sharing.link_copy')}</button>
          </div>
          <p class="sd-muted">{$_('sharing.link_on_hint')}</p>
          <button class="sd-leave" on:click={removeLink} disabled={linkBusy}>
            <span class="material-symbols-rounded">link_off</span>{$_('sharing.link_remove')}
          </button>
        {:else}
          <p class="sd-muted">{$_('sharing.link_off_hint')}</p>
          <button class="sd-make" on:click={createLink} disabled={linkBusy}>
            <span class="material-symbols-rounded">add_link</span>{$_('sharing.link_create')}
          </button>
        {/if}
      </div>
    {:else}
      <p class="sd-muted">{data.role === 'view' ? $_('sharing.member_view_hint') : $_('sharing.member_edit_hint')}</p>
      <button class="sd-leave" on:click={leave}>
        <span class="material-symbols-rounded">logout</span>{$_('sharing.leave')}
      </button>
    {/if}
  {/if}
</div>

<style>
  .sd { display: flex; flex-direction: column; gap: 10px; width: 360px; max-width: 100%; }
  :global(.pop-panel.sheet) .sd { width: 100%; }
  .sd-title { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .sd-muted { font-size: 12px; color: var(--text-3); line-height: 1.45; }
  .sd-list { list-style: none; display: flex; flex-direction: column; gap: 2px; }
  .sd-row { display: flex; align-items: center; gap: 10px; min-height: 48px; }
  .sd-avatar {
    width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--accent-dim); color: var(--accent); font-weight: 600; font-size: 14px;
  }
  .sd-name { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 14px; color: var(--text-1); overflow-wrap: anywhere; }
  .sd-you { color: var(--text-3); margin-left: 4px; }
  .sd-sub { font-size: 12px; color: var(--text-3); }
  .sd-role-text { flex-shrink: 0; }
  .sd-role {
    height: 34px; padding: 0 6px; flex-shrink: 0;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--text-1); font-size: 13px;
  }
  .sd-x { width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: var(--text-2); flex-shrink: 0; }
  .sd-x:hover { background: color-mix(in srgb, var(--text-1) 9%, transparent); color: var(--text-1); }
  .sd-x .material-symbols-rounded { font-size: 18px; }
  .sd-add {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 6px 6px 6px 10px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-md);
  }
  .sd-add > .material-symbols-rounded { color: var(--text-3); font-size: 20px; }
  .sd-input { flex: 1 1 120px; min-width: 0; height: 36px; background: none; border: none; outline: none; color: var(--text-1); font-size: 14px; }
  .sd-go { height: 34px; padding: 0 14px; }
  .sd-leave {
    display: flex; align-items: center; gap: 8px;
    min-height: 40px; padding: 0 8px; margin: 0 -6px;
    border-radius: 10px; color: var(--danger); font-size: 14px; font-weight: 500;
  }
  .sd-leave:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); }
  .sd-leave .material-symbols-rounded { font-size: 19px; }
  .sd-public { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
  .sd-link {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 6px 6px 10px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-md);
  }
  .sd-link > .material-symbols-rounded:first-child { color: var(--accent); font-size: 20px; }
  .sd-link .sd-input { font-size: 13px; color: var(--text-2); text-overflow: ellipsis; }
  .sd-make {
    display: flex; align-items: center; gap: 8px; align-self: flex-start;
    min-height: 40px; padding: 0 8px; margin: 0 -6px;
    border-radius: 10px; color: var(--accent); font-size: 14px; font-weight: 500;
  }
  .sd-make:hover { background: var(--accent-dim); }
  .sd-make .material-symbols-rounded { font-size: 19px; }
  .sd-make:disabled, .sd-leave:disabled { opacity: 0.5; }
</style>
