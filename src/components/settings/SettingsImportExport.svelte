<script>
  // Import from Google Keep (Takeout) or Markdown files, and export every
  // note as Markdown. Works on the web, Android with a server, and local mode.
  import { _ } from 'svelte-i18n';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { signalNotesChanged, refreshLabels } from '../../stores/notes.js';
  import { parseImportFile, importParsedNotes, buildMarkdownExport } from '../../lib/import-export/index.js';
  import { fetchMemos } from '../../lib/import-export/memos.js';
  import { shareBlob } from '../../lib/share-file.js';
  import { currentUser } from '../../stores/auth.js';

  let includeTrashed = false;
  let tagsToLabels = true;
  let busy = null;          // 'keep' | 'markdown' | 'export'
  let progress = '';
  let summary = null;       // { source, imported, skipped, labels_created, images, imagesMissing, imagesFailed, attachments, unreadable, trashedSkipped }
  let keepInput, mdInput, blinkoInput;
  let memosUrl = '';
  let memosToken = '';

  async function runMemos() {
    if (busy || !memosUrl.trim() || !memosToken.trim()) return;
    busy = 'memos';
    summary = null;
    progress = $_('import_export.memos_connecting');
    try {
      const parsed = await fetchMemos(memosUrl, memosToken.trim(), (count) => {
        progress = $_('import_export.memos_reading', { values: { count } });
      });
      if (!parsed.notes.length) { showError($_('import_export.no_memos_notes')); return; }
      const r = await importParsedNotes(parsed, ({ done, total, phase }) => {
        progress = $_(phase === 'images' ? 'import_export.progress_images' : 'import_export.progress', { values: { done, total } });
      });
      summary = { source: 'memos', ...r, attachments: parsed.attachments, unreadable: 0, trashedSkipped: 0 };
      memosToken = '';
      signalNotesChanged();
      refreshLabels();
      showSuccess($_('import_export.imported_toast', { values: { count: r.imported } }));
    } catch (e) {
      const msg = e?.message === 'memos_auth' ? $_('import_export.memos_auth_failed')
        : e?.message === 'memos_unreachable' ? $_('import_export.memos_unreachable')
        : (e?.message || $_('import_export.import_failed'));
      showError(msg);
    } finally {
      busy = null;
      progress = '';
    }
  }

  async function runImport(source, file) {
    if (!file || busy) return;
    busy = source;
    summary = null;
    progress = $_('import_export.reading');
    try {
      const parsed = await parseImportFile(file, source, {
        includeTrashed,
        tagsToLabels,
        username: $currentUser?.username || '',
      });
      if (parsed.blinkoAccounts) {
        showError($_('import_export.blinko_accounts', { values: { names: parsed.blinkoAccounts.join(', ') } }));
        return;
      }
      if (!parsed.notes.length) {
        showError($_(`import_export.no_${source}_notes`));
        return;
      }
      const r = await importParsedNotes(parsed, ({ done, total, phase }) => {
        progress = $_(phase === 'images' ? 'import_export.progress_images' : 'import_export.progress', { values: { done, total } });
      });
      summary = { source, ...r, attachments: parsed.attachments, unreadable: parsed.unreadable, trashedSkipped: parsed.trashedSkipped };
      signalNotesChanged();
      refreshLabels();
      showSuccess($_('import_export.imported_toast', { values: { count: r.imported } }));
    } catch (e) {
      showError(e?.message || $_('import_export.import_failed'));
    } finally {
      busy = null;
      progress = '';
      if (keepInput) keepInput.value = '';
      if (mdInput) mdInput.value = '';
      if (blinkoInput) blinkoInput.value = '';
    }
  }

  async function exportMarkdown() {
    if (busy) return;
    busy = 'export';
    try {
      const { blob, count } = await buildMarkdownExport((done, total) => {
        progress = $_('import_export.export_progress', { values: { done, total } });
      });
      progress = '';
      const name = `notetrace-markdown-${new Date().toISOString().slice(0, 10)}.zip`;
      const res = await shareBlob(blob, name, $_('import_export.export_share_title'));
      if (!res?.canceled) showSuccess($_('import_export.exported_toast', { values: { count } }));
    } catch (e) {
      showError(e?.message || $_('import_export.export_failed'));
    } finally {
      busy = null;
      progress = '';
    }
  }
</script>

<div class="ie-body">
  <p class="sub-label">{$_('import_export.import')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('import_export.keep_title')}</span>
        <span class="setting-desc">{$_('import_export.keep_desc')}</span>
      </div>
      <button class="btn btn-secondary" on:click={() => keepInput.click()} disabled={!!busy}>
        <span class="material-symbols-rounded">upload_file</span>
        {busy === 'keep' ? $_('import_export.importing') : $_('import_export.choose_file')}
      </button>
      <input bind:this={keepInput} type="file" accept=".zip,.json,application/zip,application/json" hidden
        on:change={(e) => runImport('keep', e.target.files?.[0])} />
    </div>
    <div class="setting-row sub">
      <div>
        <span class="setting-label">{$_('import_export.include_trashed')}</span>
      </div>
      <input type="checkbox" class="toggle-cb" bind:checked={includeTrashed} disabled={!!busy} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('import_export.memos_title')}</span>
        <span class="setting-desc">{$_('import_export.memos_desc')}</span>
      </div>
    </div>
    <form class="memos-form" on:submit|preventDefault={runMemos}>
      <input class="input" type="url" inputmode="url" autocapitalize="none" spellcheck="false" bind:value={memosUrl}
        placeholder={$_('import_export.memos_url_placeholder')} aria-label={$_('import_export.memos_url')} disabled={!!busy} />
      <input class="input" type="password" autocomplete="off" bind:value={memosToken}
        placeholder={$_('import_export.memos_token_placeholder')} aria-label={$_('import_export.memos_token')} disabled={!!busy} />
      <button class="btn btn-secondary" type="submit" disabled={!!busy || !memosUrl.trim() || !memosToken.trim()}>
        <span class="material-symbols-rounded">cloud_download</span>
        {busy === 'memos' ? $_('import_export.importing') : $_('import_export.memos_import')}
      </button>
    </form>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('import_export.markdown_title')}</span>
        <span class="setting-desc">{$_('import_export.markdown_desc')}</span>
      </div>
      <button class="btn btn-secondary" on:click={() => mdInput.click()} disabled={!!busy}>
        <span class="material-symbols-rounded">upload_file</span>
        {busy === 'markdown' ? $_('import_export.importing') : $_('import_export.choose_file')}
      </button>
      <input bind:this={mdInput} type="file" accept=".zip,.md,.markdown,.txt,application/zip,text/markdown,text/plain" hidden
        on:change={(e) => runImport('markdown', e.target.files?.[0])} />
    </div>
    <div class="setting-row sub">
      <div>
        <span class="setting-label">{$_('import_export.tags_to_labels')}</span>
      </div>
      <input type="checkbox" class="toggle-cb" bind:checked={tagsToLabels} disabled={!!busy} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('import_export.blinko_title')}</span>
        <span class="setting-desc">{$_('import_export.blinko_desc')}</span>
      </div>
      <button class="btn btn-secondary" on:click={() => blinkoInput.click()} disabled={!!busy}>
        <span class="material-symbols-rounded">upload_file</span>
        {busy === 'blinko' ? $_('import_export.importing') : $_('import_export.choose_file')}
      </button>
      <input bind:this={blinkoInput} type="file" accept=".bko,.zip,application/zip" hidden
        on:change={(e) => runImport('blinko', e.target.files?.[0])} />
    </div>

    {#if progress && busy !== 'export'}
      <div class="setting-divider"></div>
      <p class="ie-status" aria-live="polite">{progress}</p>
    {:else if summary}
      <div class="setting-divider"></div>
      <div class="ie-status" aria-live="polite">
        <p>{$_('import_export.summary_imported', { values: { count: summary.imported } })}</p>
        {#if summary.skipped}<p class="muted">{$_('import_export.summary_skipped', { values: { count: summary.skipped } })}</p>{/if}
        {#if summary.images}<p class="muted">{$_('import_export.summary_images', { values: { count: summary.images } })}</p>{/if}
        {#if summary.imagesMissing || summary.imagesFailed}<p class="muted">{$_('import_export.summary_images_failed', { values: { count: summary.imagesMissing + summary.imagesFailed } })}</p>{/if}
        {#if summary.labels_created}<p class="muted">{$_('import_export.summary_labels', { values: { count: summary.labels_created } })}</p>{/if}
        {#if summary.trashedSkipped}<p class="muted">{$_(summary.source === 'blinko' ? 'import_export.summary_blinko_trashed' : 'import_export.summary_trashed', { values: { count: summary.trashedSkipped } })}</p>{/if}
        {#if summary.attachments}<p class="muted">{$_('import_export.summary_attachments', { values: { count: summary.attachments } })}</p>{/if}
        {#if summary.unreadable}<p class="muted">{$_('import_export.summary_unreadable', { values: { count: summary.unreadable } })}</p>{/if}
      </div>
    {/if}
  </div>

  <p class="sub-label">{$_('import_export.export')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('import_export.export_title')}</span>
        <span class="setting-desc">{$_('import_export.export_desc')}</span>
      </div>
      <button class="btn btn-secondary" on:click={exportMarkdown} disabled={!!busy}>
        <span class="material-symbols-rounded">download</span>
        {busy === 'export' ? $_('import_export.exporting') : $_('import_export.export_button')}
      </button>
    </div>
    {#if busy === 'export' && progress}
      <div class="setting-divider"></div>
      <p class="ie-status" aria-live="polite">{progress}</p>
    {/if}
  </div>
</div>

<style>
  .ie-body { display: flex; flex-direction: column; gap: 10px; }
  .sub-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--text-3); padding: 4px 2px 2px; margin: 0;
  }
  .card.settings-card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); overflow: hidden;
  }
  .setting-row {
    display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;
    gap: 12px; padding: 14px 16px;
  }
  .setting-row.sub { padding-top: 0; }
  .setting-row > div:first-child { flex: 1 1 220px; min-width: 0; }
  .setting-label { font-size: 14px; color: var(--text-1); display: block; font-weight: 500; }
  .setting-row.sub .setting-label { font-size: 13px; color: var(--text-2); font-weight: 400; }
  .setting-desc { font-size: 12px; color: var(--text-3); margin-top: 4px; line-height: 1.45; display: block; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }
  .btn { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .btn .material-symbols-rounded { font-size: 18px; }
  .ie-status { padding: 12px 16px; font-size: 13px; color: var(--text-1); display: flex; flex-direction: column; gap: 4px; }
  .ie-status .muted { color: var(--text-3); font-size: 12px; }
  .memos-form { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 14px; }
  .memos-form .input { flex: 1 1 200px; min-width: 0; }
  .input {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 9px 12px; color: var(--text-1); font-size: 14px; height: 40px;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .toggle-cb {
    width: 40px; height: 24px; flex-shrink: 0;
    appearance: none; -webkit-appearance: none;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 99px;
    position: relative; cursor: pointer;
    transition: background var(--dur-fast);
  }
  .toggle-cb::after {
    content: '';
    position: absolute; top: 1px; left: 1px;
    width: 20px; height: 20px;
    background: var(--text-3); border-radius: 50%;
    transition: transform var(--dur-base) var(--ease-spring), background var(--dur-fast);
  }
  .toggle-cb:checked { background: var(--accent-dim); border-color: var(--accent); }
  .toggle-cb:checked::after { background: var(--accent); transform: translateX(16px); }
  .toggle-cb:disabled { opacity: 0.5; cursor: default; }
</style>
