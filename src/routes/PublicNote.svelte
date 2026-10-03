<script>
  /**
   * PublicNote: a note opened through its public link (/n/<token>).
   *
   * Mounted on its own by main.js, without the app around it: no sign-in,
   * no local database, no sync, no service worker. Read-only. The server
   * decides what a stranger may see (lib/notes.js getPublicNote); this only
   * shows it.
   */
  import { onMount, tick } from 'svelte';
  import { _ } from 'svelte-i18n';
  import TipTapEditor from '../components/notes/TipTapEditor.svelte';
  import { apiUrl, resolveAssetUrl, iconUrl } from '../lib/platform.js';
  import { noteColorStyle } from '../lib/note-colors.js';

  export let token;

  let state = 'loading'; // 'loading' | 'ready' | 'gone' | 'error'
  let note = null;
  let bodyEl;

  $: open = (note?.items || []).filter(i => !i.checked);
  $: done = (note?.items || []).filter(i => i.checked);
  $: pictures = (note?.attachments || []).filter(a => /^image\//.test(a.mime || ''));
  $: sounds = (note?.attachments || []).filter(a => /^audio\//.test(a.mime || ''));
  $: files = (note?.attachments || []).filter(a => !/^(image|audio)\//.test(a.mime || ''));
  $: updated = note?.updated_at ? formatDate(note.updated_at) : '';

  function formatDate(s) {
    const d = new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
  }

  async function load() {
    state = 'loading';
    try {
      const res = await fetch(apiUrl(`/api/n/${encodeURIComponent(token)}`), { credentials: 'omit', cache: 'no-store' });
      if (res.status === 404 || res.status === 400) { state = 'gone'; return; }
      if (!res.ok) throw new Error(String(res.status));
      note = await res.json();
      document.title = (note.title || '').trim() || $_('public_note.untitled');
      state = 'ready';
      await tick();
      inertNoteLinks();
    } catch {
      state = 'error';
    }
  }

  // [[Note links]] point at notes the reader can't open. Keep the text,
  // drop what makes them look and act like links.
  function inertNoteLinks() {
    for (const chip of bodyEl?.querySelectorAll('.note-link') || []) {
      chip.removeAttribute('role');
      chip.removeAttribute('tabindex');
    }
  }

  onMount(load);
</script>

<div class="pn">
  <header class="pn-bar">
    <img class="pn-logo" src={iconUrl('/icons/logo.png')} alt="" />
    <span class="pn-brand">NoteTrace</span>
  </header>

  <main class="pn-main">
    {#if state === 'loading'}
      <p class="pn-muted pn-center">{$_('common.loading')}</p>
    {:else if state === 'gone'}
      <div class="pn-empty">
        <span class="material-symbols-rounded">link_off</span>
        <h1>{$_('public_note.gone_title')}</h1>
        <p class="pn-muted">{$_('public_note.gone_body')}</p>
      </div>
    {:else if state === 'error'}
      <div class="pn-empty">
        <span class="material-symbols-rounded">cloud_off</span>
        <h1>{$_('public_note.error_title')}</h1>
        <p class="pn-muted">{$_('public_note.error_body')}</p>
        <button class="btn btn-primary" on:click={load}>{$_('public_note.retry')}</button>
      </div>
    {:else if note}
      <article class="pn-note" style={noteColorStyle(note.color)}>
        {#if note.title}<h1 class="pn-title">{note.title}</h1>{/if}

        {#if pictures.length}
          <div class="pn-pictures" class:single={pictures.length === 1}>
            {#each pictures as a (a.url)}
              <a href={resolveAssetUrl(a.url)} target="_blank" rel="noopener noreferrer">
                <img src={resolveAssetUrl(a.preview_url || a.url)} alt={a.name || ''} loading="lazy"
                  width={a.width || undefined} height={a.height || undefined} />
              </a>
            {/each}
          </div>
        {/if}

        {#if note.kind === 'checklist'}
          <ul class="pn-items">
            {#each open as item}
              <li><input type="checkbox" disabled /><span>{item.text}</span></li>
            {/each}
          </ul>
          {#if done.length}
            <p class="pn-done-head">{$_('public_note.checked', { values: { count: done.length } })}</p>
            <ul class="pn-items pn-done">
              {#each done as item}
                <li><input type="checkbox" checked disabled /><span>{item.text}</span></li>
              {/each}
            </ul>
          {/if}
        {:else if note.body_md}
          <div class="pn-body" bind:this={bodyEl}>
            <TipTapEditor value={note.body_md} editable={false} showToolbar={false} />
          </div>
        {/if}

        {#if sounds.length}
          <div class="pn-sounds">
            {#each sounds as a (a.url)}
              <audio controls preload="metadata" src={resolveAssetUrl(a.url)}></audio>
            {/each}
          </div>
        {/if}

        {#if files.length}
          <ul class="pn-files">
            {#each files as a (a.url)}
              <li>
                <a href={resolveAssetUrl(a.url)} target="_blank" rel="noopener noreferrer">
                  <span class="material-symbols-rounded">description</span>
                  <span class="pn-file-name">{a.name || $_('public_note.file')}</span>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </article>

      <footer class="pn-foot">
        {#if updated}<span>{$_('public_note.updated', { values: { date: updated } })}</span>{/if}
        <span>{$_('public_note.read_only')}</span>
      </footer>
    {/if}
  </main>
</div>

<style>
  .pn {
    min-height: 100dvh;
    display: flex; flex-direction: column;
    background: var(--bg);
    color: var(--text-1);
  }
  .pn-bar {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 16px;
    padding-top: max(14px, env(safe-area-inset-top));
    max-width: 760px; width: 100%; margin: 0 auto;
  }
  .pn-logo { width: 28px; height: 28px; border-radius: 7px; }
  .pn-brand {
    font-size: 16px; font-weight: 700; letter-spacing: -0.01em;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .pn-main {
    flex: 1;
    max-width: 760px; width: 100%; margin: 0 auto;
    padding: 4px 16px max(32px, env(safe-area-inset-bottom));
    min-width: 0;
  }
  .pn-center { text-align: center; padding-top: 20vh; }
  .pn-muted { color: var(--text-3); font-size: 14px; line-height: 1.5; }

  .pn-note {
    background: var(--note-bg);
    border: 1px solid var(--note-border);
    border-radius: var(--radius-lg, 16px);
    padding: 20px;
    display: flex; flex-direction: column; gap: 14px;
    min-width: 0;
  }
  .pn-title { font-size: 24px; line-height: 1.3; font-weight: 700; overflow-wrap: anywhere; }

  .pn-body :global(.tiptap-host) { min-height: 0; }
  .pn-body :global(.note-link) { cursor: text; }
  .pn-body :global(.tiptap-host .tiptap-body .note-link.ProseMirror-selectednode) { outline: none; }
  /* A link whose address the editor refused (javascript: and the like) is
     left with an empty href: show it as the text it is. */
  .pn-body :global(a[href=""]) { pointer-events: none; color: inherit; text-decoration: none; }

  .pn-pictures { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
  .pn-pictures.single { grid-template-columns: minmax(0, 1fr); }
  .pn-pictures a { display: block; border-radius: 10px; overflow: hidden; background: color-mix(in srgb, var(--text-1) 6%, transparent); }
  .pn-pictures img { display: block; width: 100%; height: 100%; max-height: 420px; object-fit: cover; }
  .pn-pictures.single img { height: auto; object-fit: contain; }

  .pn-items { list-style: none; display: flex; flex-direction: column; gap: 2px; }
  .pn-items li { display: flex; align-items: flex-start; gap: 10px; padding: 6px 0; font-size: 16px; line-height: 1.5; overflow-wrap: anywhere; min-width: 0; }
  /* Same boxes as the editor's task lists, never greyed out as disabled. */
  .pn-items input {
    appearance: none; -webkit-appearance: none; margin: 4px 0 0; flex-shrink: 0;
    width: 18px; height: 18px; border-radius: 5px;
    border: 2px solid var(--text-3); background: transparent; display: grid; place-content: center;
  }
  .pn-items input::after {
    content: ''; width: 5px; height: 10px; margin-top: -2px;
    border: solid var(--accent-text); border-width: 0 2px 2px 0; transform: rotate(45deg) scale(0);
  }
  .pn-items input:checked { background: var(--accent); border-color: var(--accent); }
  .pn-items input:checked::after { transform: rotate(45deg) scale(1); }
  .pn-done-head { font-size: 13px; color: var(--text-3); padding-top: 6px; border-top: 1px solid var(--note-border); }
  .pn-done li span { color: var(--text-3); text-decoration: line-through; }

  .pn-sounds { display: flex; flex-direction: column; gap: 8px; }
  .pn-sounds audio { width: 100%; }

  .pn-files { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .pn-files a {
    display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px;
    border-radius: 10px; background: color-mix(in srgb, var(--text-1) 6%, transparent);
    color: var(--text-1); text-decoration: none; font-size: 14px; min-width: 0;
  }
  .pn-files .material-symbols-rounded { color: var(--text-3); font-size: 20px; }
  .pn-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

  .pn-foot {
    display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 16px;
    padding: 12px 4px 0; font-size: 12px; color: var(--text-3);
  }

  .pn-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding-top: 18vh; }
  .pn-empty > .material-symbols-rounded { font-size: 44px; color: var(--text-3); }
  .pn-empty h1 { font-size: 20px; font-weight: 600; }
  .pn-empty .pn-muted { max-width: 340px; }
  .pn-empty .btn { margin-top: 6px; }
</style>
