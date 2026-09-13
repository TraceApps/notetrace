<script>
  /**
   * TipTapEditor: rich text editing for note bodies, stored as Markdown.
   *
   * The editor renders formatted text but reads and writes Markdown, so
   * what lands in the database (and exports, and sync) is plain,
   * portable text. Underline is off because Markdown has no syntax for it.
   */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import { Markdown } from '@tiptap/markdown';
  import { Placeholder } from '@tiptap/extensions';

  /** Markdown source. Read on mount; later external changes reload it. */
  export let value = '';
  export let placeholder = '';
  export let editable = true;
  export let showToolbar = true;

  const dispatch = createEventDispatcher();
  let el;
  let editor = null;
  let lastEmitted = value;
  let active = {};

  onMount(() => {
    editor = new Editor({
      element: el,
      editable,
      extensions: [
        StarterKit.configure({
          underline: false,
          heading: { levels: [1, 2, 3] },
          link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
        }),
        Markdown,
        Placeholder.configure({ placeholder }),
      ],
      content: value || '',
      contentType: 'markdown',
      editorProps: { attributes: { class: 'tiptap-body', spellcheck: 'true' } },
      onUpdate: ({ editor: ed }) => {
        const md = ed.getMarkdown();
        lastEmitted = md;
        value = md;
        dispatch('change', md);
        refreshActive();
      },
      onSelectionUpdate: refreshActive,
      onFocus: () => dispatch('focus'),
      onBlur: () => dispatch('blur'),
    });
    refreshActive();
  });

  onDestroy(() => editor?.destroy());

  // Reload when the value changes from outside (version restore, sync),
  // never for our own keystrokes, or the cursor would jump.
  $: if (editor && value !== lastEmitted) {
    lastEmitted = value;
    editor.commands.setContent(value || '', { contentType: 'markdown', emitUpdate: false });
  }
  $: if (editor && editor.isEditable !== editable) editor.setEditable(editable);

  function refreshActive() {
    if (!editor) return;
    active = {
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      strike: editor.isActive('strike'),
      h: editor.isActive('heading'),
      bullet: editor.isActive('bulletList'),
      ordered: editor.isActive('orderedList'),
      quote: editor.isActive('blockquote'),
      code: editor.isActive('code'),
    };
  }

  export function focus() { editor?.commands.focus('end'); }

  function run(fn) {
    if (!editor) return;
    fn(editor.chain().focus()).run();
    refreshActive();
  }

  const tools = [
    { key: 'h', icon: 'title', label: 'notes.fmt_heading', fn: c => c.toggleHeading({ level: 2 }) },
    { key: 'bold', icon: 'format_bold', label: 'notes.fmt_bold', fn: c => c.toggleBold() },
    { key: 'italic', icon: 'format_italic', label: 'notes.fmt_italic', fn: c => c.toggleItalic() },
    { key: 'strike', icon: 'strikethrough_s', label: 'notes.fmt_strike', fn: c => c.toggleStrike() },
    { key: 'bullet', icon: 'format_list_bulleted', label: 'notes.fmt_bullets', fn: c => c.toggleBulletList() },
    { key: 'ordered', icon: 'format_list_numbered', label: 'notes.fmt_numbers', fn: c => c.toggleOrderedList() },
    { key: 'quote', icon: 'format_quote', label: 'notes.fmt_quote', fn: c => c.toggleBlockquote() },
    { key: 'code', icon: 'code', label: 'notes.fmt_code', fn: c => c.toggleCode() },
  ];
</script>

{#if showToolbar && editable}
  <div class="fmt-bar" role="toolbar" aria-label={$_('notes.formatting')}>
    {#each tools as t (t.key)}
      <button type="button" class="fmt-btn" class:on={active[t.key]}
        title={$_(t.label)} aria-label={$_(t.label)} aria-pressed={!!active[t.key]}
        on:mousedown|preventDefault
        on:click={() => run(t.fn)}>
        <span class="material-symbols-rounded">{t.icon}</span>
      </button>
    {/each}
  </div>
{/if}
<div class="tiptap-host" bind:this={el}></div>

<style>
  .fmt-bar {
    display: flex; flex-wrap: wrap; gap: 2px;
    margin: 0 -6px 6px;
  }
  .fmt-btn {
    width: 34px; height: 34px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 9px;
    color: var(--text-2);
  }
  .fmt-btn .material-symbols-rounded { font-size: 20px; }
  .fmt-btn:hover { background: color-mix(in srgb, var(--text-1) 8%, transparent); color: var(--text-1); }
  .fmt-btn.on { background: var(--accent-dim); color: var(--accent); }

  .tiptap-host { min-height: 120px; }
  .tiptap-host :global(.tiptap-body) {
    outline: none;
    font-size: 16px;
    line-height: 1.7;
    color: color-mix(in srgb, var(--text-1) 88%, transparent);
    overflow-wrap: anywhere;
    min-height: 120px;
  }
  .tiptap-host :global(.tiptap-body > * + *) { margin-top: 0.6em; }
  .tiptap-host :global(.tiptap-body h1) { font-family: var(--font-note-title); font-weight: 600; font-size: 1.6em; line-height: 1.2; }
  .tiptap-host :global(.tiptap-body h2) { font-family: var(--font-note-title); font-weight: 600; font-size: 1.3em; line-height: 1.25; }
  .tiptap-host :global(.tiptap-body h3) { font-weight: 600; font-size: 1.05em; }
  .tiptap-host :global(.tiptap-body strong) { color: var(--text-1); font-weight: 600; }
  .tiptap-host :global(.tiptap-body ul),
  .tiptap-host :global(.tiptap-body ol) { padding-left: 1.4em; }
  .tiptap-host :global(.tiptap-body li + li) { margin-top: 0.2em; }
  .tiptap-host :global(.tiptap-body li p) { margin: 0; }
  .tiptap-host :global(.tiptap-body blockquote) {
    padding-left: 12px;
    border-left: 3px solid var(--border-strong);
    color: var(--text-2);
  }
  .tiptap-host :global(.tiptap-body code) {
    font-family: ui-monospace, 'JetBrains Mono', monospace;
    font-size: 0.88em;
    background: color-mix(in srgb, var(--text-1) 8%, transparent);
    border-radius: 6px;
    padding: 2px 6px;
  }
  .tiptap-host :global(.tiptap-body pre) {
    background: color-mix(in srgb, var(--text-1) 6%, transparent);
    border-radius: 10px;
    padding: 12px 14px;
    overflow-x: auto;
  }
  .tiptap-host :global(.tiptap-body pre code) { background: none; padding: 0; }
  .tiptap-host :global(.tiptap-body a) { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  .tiptap-host :global(.tiptap-body hr) { border: none; border-top: 1px solid var(--border-strong); }
  .tiptap-host :global(.tiptap-body p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    color: var(--text-3);
    float: left;
    height: 0;
    pointer-events: none;
  }
</style>
