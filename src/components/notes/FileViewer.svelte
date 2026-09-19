<script>
  /**
   * FileViewer: one of a note's files, full screen. PDFs are drawn page by
   * page (only the pages near the screen), text files show as text, videos
   * play, and anything else says what it is and offers Download (or Open, in
   * the Android app). Arrow keys and the side buttons step through the note's
   * files.
   */
  import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';
  import { dialogFocus } from '../../lib/dialog-focus.js';
  import { onBack } from '../../lib/back-stack.js';
  import { isNative, resolveAssetUrl } from '../../lib/platform.js';
  import { fetchAttachmentBlob } from '../../lib/ai-extract.js';
  import { fileIcon, fileTypeLabel, formatBytes, displayName, previewKind } from '../../lib/file-kinds.js';
  import { openFileAttachment } from '../../lib/file-open.js';
  import { showError } from '../../stores/toast.js';

  export let files = [];
  export let index = 0;

  const dispatch = createEventDispatcher();
  const TEXT_PREVIEW_BYTES = 1024 * 1024;

  $: current = files[Math.min(index, files.length - 1)] || null;
  $: kind = current ? previewKind(current) : 'none';

  let blob = null;
  let text = '';
  let truncated = false;
  let loading = false;
  let failed = false;
  let pageCount = 0;
  let pdfDoc = null;
  let pagesEl;
  let pageWidth = 0;
  let observer = null;
  let opening = false;
  let loadSeq = 0;

  $: current, load(current);

  async function load(file) {
    const seq = ++loadSeq;
    cleanup();
    blob = null; text = ''; truncated = false; failed = false; pageCount = 0;
    if (!file || (kind !== 'pdf' && kind !== 'text')) return;
    loading = true;
    try {
      const data = await fetchAttachmentBlob(file.url);
      if (seq !== loadSeq) return;
      blob = data;
      if (kind === 'text') {
        truncated = data.size > TEXT_PREVIEW_BYTES;
        text = await data.slice(0, TEXT_PREVIEW_BYTES).text();
      } else {
        const { openPdf, closePdf } = await import('../../lib/pdf.js');
        const doc = await openPdf(data);
        if (seq !== loadSeq) { closePdf(doc); return; }
        pdfDoc = doc;
        // The page width is known before the pages appear, so none of them start at zero.
        pageWidth = Math.max(200, Math.min(900, (pagesEl?.clientWidth || window.innerWidth) - 24));
        pageCount = doc.numPages;
        loading = false;        // the pages have to be on screen before they're watched
        await tick();
        watchPages(seq);
      }
    } catch {
      if (seq === loadSeq) failed = true;
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  // Pages are drawn as they come near the screen, so a long PDF opens at once.
  function watchPages(seq) {
    if (!pagesEl || !pdfDoc) return;
    const drawn = new Set();
    observer = new IntersectionObserver(async (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const n = Number(entry.target.dataset.page);
        if (drawn.has(n)) continue;
        drawn.add(n);
        const canvas = entry.target.querySelector('canvas');
        try {
          const { renderPage } = await import('../../lib/pdf.js');
          if (seq !== loadSeq || !pdfDoc) return;
          const size = await renderPage(pdfDoc, n, canvas, pageWidth);
          entry.target.style.aspectRatio = `${size.width} / ${size.height}`;
          entry.target.classList.add('ready');
        } catch { drawn.delete(n); }
      }
    }, { root: pagesEl, rootMargin: '800px 0px' });
    for (const el of pagesEl.querySelectorAll('.page')) observer.observe(el);
  }

  function cleanup() {
    observer?.disconnect();
    observer = null;
    const doc = pdfDoc;
    pdfDoc = null;
    if (doc) import('../../lib/pdf.js').then(({ closePdf }) => closePdf(doc));
  }

  async function openOrDownload() {
    if (!current || opening) return;
    opening = true;
    try {
      await openFileAttachment(current, blob);
    } catch (e) {
      showError($_('files.open_failed', { values: { error: e?.message || '' } }));
    } finally {
      opening = false;
    }
  }

  const go = (d) => { if (files.length > 1) index = (index + d + files.length) % files.length; };
  const close = () => dispatch('close');

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowRight' && files.length > 1) { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft' && files.length > 1) { e.preventDefault(); go(-1); }
  }
  let releaseBack = () => {};
  onMount(() => { window.addEventListener('keydown', onKey, true); releaseBack = onBack(close); });
  onDestroy(() => { window.removeEventListener('keydown', onKey, true); releaseBack(); cleanup(); });
</script>

<div use:portal class="fv" role="dialog" aria-modal="true" tabindex="-1" use:dialogFocus aria-label={current ? displayName(current) : $_('files.title')} transition:fade={{ duration: 150 }}>
  {#if current}
    <header class="fv-bar">
      <span class="fv-icon material-symbols-rounded" aria-hidden="true">{fileIcon(current)}</span>
      <div class="fv-title">
        <span class="fv-name">{displayName(current)}</span>
        <span class="fv-meta">
          <span>{fileTypeLabel(current)}</span>
          {#if current.size_bytes != null}<span class="dot" aria-hidden="true">·</span><span>{formatBytes(current.size_bytes)}</span>{/if}
          {#if pageCount}<span class="dot" aria-hidden="true">·</span><span>{$_('files.pages', { values: { count: pageCount } })}</span>{/if}
          {#if files.length > 1}<span class="dot" aria-hidden="true">·</span><span>{index + 1} / {files.length}</span>{/if}
        </span>
      </div>
      <button class="fv-action" on:click={openOrDownload} disabled={opening}>
        <span class="material-symbols-rounded" class:spin={opening}>{opening ? 'progress_activity' : isNative ? 'open_in_new' : 'download'}</span>
        <span class="fv-action-label">{isNative ? $_('files.open_with') : $_('files.download')}</span>
      </button>
      <button class="fv-btn" on:click={close} aria-label={$_('common.close')}>
        <span class="material-symbols-rounded">close</span>
      </button>
    </header>

    <div class="fv-body" class:fv-pages-body={kind === 'pdf'} bind:this={pagesEl}>
      {#if kind === 'video'}
        <!-- svelte-ignore a11y-media-has-caption -->
        <video class="fv-video" src={resolveAssetUrl(current.url)} controls playsinline preload="metadata"></video>
      {:else if loading}
        <div class="fv-state"><span class="material-symbols-rounded spin">progress_activity</span></div>
      {:else if failed}
        <div class="fv-state">
          <span class="material-symbols-rounded fv-big">{fileIcon(current)}</span>
          <p>{$_('files.preview_failed')}</p>
        </div>
      {:else if kind === 'pdf'}
        {#each Array(pageCount) as _p, i}
          <div class="page" data-page={i + 1} style="width:{pageWidth}px" aria-label={$_('files.page', { values: { n: i + 1 } })}>
            <canvas></canvas>
          </div>
        {/each}
      {:else if kind === 'text'}
        <pre class="fv-text">{text}</pre>
        {#if truncated}<p class="fv-note">{$_('files.text_truncated')}</p>{/if}
      {:else}
        <div class="fv-state">
          <span class="material-symbols-rounded fv-big">{fileIcon(current)}</span>
          <p class="fv-state-title">{displayName(current)}</p>
          <p>{$_('files.no_preview', { values: { type: fileTypeLabel(current) } })}</p>
          <button class="btn btn-primary" on:click={openOrDownload} disabled={opening}>
            <span class="material-symbols-rounded">{isNative ? 'open_in_new' : 'download'}</span>{isNative ? $_('files.open_with') : $_('files.download')}
          </button>
        </div>
      {/if}
    </div>

    {#if files.length > 1}
      <button class="fv-btn fv-prev" on:click={() => go(-1)} aria-label={$_('files.previous')}><span class="material-symbols-rounded">chevron_left</span></button>
      <button class="fv-btn fv-next" on:click={() => go(1)} aria-label={$_('files.next')}><span class="material-symbols-rounded">chevron_right</span></button>
    {/if}
  {/if}
</div>

<style>
  .fv {
    position: fixed; inset: 0; z-index: 3000;
    display: flex; flex-direction: column;
    background: rgb(10, 11, 15); color: #f1f1f4;
  }
  .fv-bar {
    display: flex; align-items: center; gap: 12px; flex-shrink: 0;
    padding: calc(10px + var(--safe-top, 0px)) 12px 10px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .fv-icon { font-size: 26px; color: var(--accent); flex-shrink: 0; }
  .fv-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .fv-name { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fv-meta { font-size: 12px; color: rgba(255, 255, 255, 0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fv-meta .dot { margin: 0 6px; }
  .fv-action {
    display: inline-flex; align-items: center; gap: 6px; height: 38px; padding: 0 14px; border-radius: 10px; flex-shrink: 0;
    background: rgba(255, 255, 255, 0.12); color: #fff; font-size: 14px; font-weight: 600;
  }
  .fv-action:hover:not(:disabled) { background: rgba(255, 255, 255, 0.22); }
  .fv-action .material-symbols-rounded { font-size: 19px; }
  .fv-btn {
    width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: rgba(255, 255, 255, 0.12); color: #fff;
  }
  .fv-btn:hover { background: rgba(255, 255, 255, 0.22); }
  .fv-prev, .fv-next { position: absolute; top: 50%; transform: translateY(-50%); }
  .fv-prev { left: 12px; }
  .fv-next { right: 12px; }
  .fv-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; align-items: center; padding: 16px 12px calc(24px + var(--safe-bottom, 0px)); }
  .fv-pages-body { gap: 14px; }
  .page { max-width: 100%; aspect-ratio: 8.5 / 11; background: #fff; border-radius: 4px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45); overflow: hidden; flex-shrink: 0; }
  .page canvas { display: block; max-width: 100%; height: auto !important; }
  .fv-video { width: min(100%, 1100px); max-height: 100%; margin: auto; border-radius: 10px; background: #000; }
  .fv-text {
    width: min(100%, 900px); margin: 0; padding: 18px 20px; border-radius: 12px;
    background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08);
    font: 13.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #e8e8ee;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .fv-note { margin-top: 10px; font-size: 12px; color: rgba(255, 255, 255, 0.55); }
  .fv-state { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; max-width: 360px; padding: 24px; color: rgba(255, 255, 255, 0.75); }
  .fv-state .material-symbols-rounded.spin { font-size: 36px; color: rgba(255, 255, 255, 0.6); }
  .fv-big { font-size: 64px; color: var(--accent); }
  .fv-state-title { font-size: 16px; font-weight: 600; color: #fff; overflow-wrap: anywhere; }
  .fv-state .btn { display: inline-flex; align-items: center; gap: 8px; margin-top: 6px; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 600px) {
    .fv-action-label { display: none; }
    .fv-action { width: 40px; padding: 0; justify-content: center; border-radius: 50%; }
    .fv-prev, .fv-next { top: auto; bottom: calc(16px + var(--safe-bottom, 0px)); transform: none; }
  }
</style>
