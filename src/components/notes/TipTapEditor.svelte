<script>
  /**
   * TipTapEditor: rich text editing for note bodies, stored as Markdown.
   *
   * The editor renders formatted text but reads and writes Markdown, so
   * what lands in the database (and exports, and sync) is plain,
   * portable text. Underline is off because Markdown has no syntax for it.
   *
   * [[Note title]] links render as chips (note-link-extension.js). Typing
   * `[[` shows matching note titles from `linkTitles`; picking one, or
   * tapping a link, emits `openlink` / inserts the link.
   */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import { Markdown } from '@tiptap/markdown';
  import { Placeholder } from '@tiptap/extensions';
  import { NoteLink } from '../../lib/note-link-extension.js';
  import { portal } from '../../lib/portal.js';

  /** Markdown source. Read on mount; later external changes reload it. */
  export let value = '';
  export let placeholder = '';
  export let editable = true;
  export let showToolbar = true;
  /** Titles offered after typing [[ (other notes the user can see). */
  export let linkTitles = [];

  const dispatch = createEventDispatcher();
  let el;
  let editor = null;
  let lastEmitted = value;
  let active = {};

  // [[ suggestions
  let suggest = null;   // { query, from, to, x, y }
  let suggestIndex = 0;
  $: suggestions = suggest ? _matches(suggest.query) : [];

  function _matches(query) {
    const q = query.trim().toLowerCase();
    const titles = [...new Set((linkTitles || []).map(t => String(t || '').trim()).filter(Boolean))];
    const list = titles
      .filter(t => !q || t.toLowerCase().includes(q))
      .sort((a, b) => (a.toLowerCase().startsWith(q) ? 0 : 1) - (b.toLowerCase().startsWith(q) ? 0 : 1) || a.localeCompare(b))
      .slice(0, 6)
      .map(title => ({ title, create: false }));
    if (q && !titles.some(t => t.toLowerCase() === q)) list.push({ title: query.trim(), create: true });
    return list;
  }

  function _updateSuggest(ed) {
    const { state, view } = ed;
    const sel = state.selection;
    if (!sel.empty || !ed.isEditable) { suggest = null; return; }
    const $from = sel.$from;
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
    const m = before.match(/\[\[([^[\]\n\ufffc]{0,60})$/);
    if (!m) { suggest = null; return; }
    const coords = view.coordsAtPos(sel.from);
    const changed = !suggest || suggest.query !== m[1];
    suggest = { query: m[1], from: sel.from - m[0].length, to: sel.from, x: coords.left, y: coords.bottom };
    if (changed) suggestIndex = 0;
  }

  function pickSuggestion(item) {
    if (!editor || !suggest || !item) return;
    editor.chain().focus()
      .deleteRange({ from: suggest.from, to: suggest.to })
      .insertContent([{ type: 'noteLink', attrs: { title: item.title } }, { type: 'text', text: ' ' }])
      .run();
    suggest = null;
  }

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
        NoteLink,
      ],
      content: value || '',
      contentType: 'markdown',
      editorProps: {
        attributes: { class: 'tiptap-body', spellcheck: 'true' },
        handleKeyDown: (view, event) => {
          if (suggest && suggestions.length) {
            if (event.key === 'ArrowDown') { suggestIndex = (suggestIndex + 1) % suggestions.length; return true; }
            if (event.key === 'ArrowUp') { suggestIndex = (suggestIndex - 1 + suggestions.length) % suggestions.length; return true; }
            if (event.key === 'Enter' || event.key === 'Tab') { pickSuggestion(suggestions[suggestIndex]); return true; }
            if (event.key === 'Escape') { suggest = null; event.stopPropagation(); return true; }
          }
          const node = view.state.selection.node;
          if (event.key === 'Enter' && node?.type.name === 'noteLink') { dispatch('openlink', node.attrs.title); return true; }
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        const md = ed.getMarkdown();
        lastEmitted = md;
        value = md;
        dispatch('change', md);
        refreshActive();
        _updateSuggest(ed);
      },
      onSelectionUpdate: ({ editor: ed }) => { refreshActive(); _updateSuggest(ed); },
      onFocus: () => dispatch('focus'),
      onBlur: () => { dispatch('blur'); setTimeout(() => { suggest = null; }, 150); },
    });
    refreshActive();
    el.addEventListener('click', onLinkClick);
  });

  // A tap on a [[link]] chip opens that note (read-only notes too).
  function onLinkClick(e) {
    // No containment check: selecting the chip on mousedown can re-render it,
    // leaving the click's target detached from the editor.
    const chip = e.target?.closest?.('.note-link');
    if (!chip) return;
    e.preventDefault();
    dispatch('openlink', chip.getAttribute('data-note-link') || chip.textContent || '');
  }

  onDestroy(() => { el?.removeEventListener('click', onLinkClick); editor?.destroy(); });

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
    dispatch('formats', active);
  }

  export function focus() { editor?.commands.focus('end'); }

  /** The formatting tools, for a toolbar outside this component (the phone editor bar). */
  export function formatTools() { return tools.map(({ key, icon, label }) => ({ key, icon, label })); }
  export function format(key) { const t = tools.find(x => x.key === key); if (t) run(t.fn); }

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
{#if suggest && suggestions.length}
  <ul use:portal class="link-suggest" role="listbox" aria-label={$_('note_links.suggestions')}
    style="left:{Math.min(suggest.x, window.innerWidth - 272)}px; top:{suggest.y + 6}px">
    {#each suggestions as item, i}
      <li role="option" aria-selected={i === suggestIndex}>
        <button type="button" class:on={i === suggestIndex} on:mousedown|preventDefault={() => pickSuggestion(item)}>
          <span class="material-symbols-rounded">{item.create ? 'add_link' : 'description'}</span>
          <span class="t">{item.create ? $_('note_links.link_new', { values: { title: item.title } }) : item.title}</span>
        </button>
      </li>
    {/each}
  </ul>
{/if}

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
  .tiptap-host :global(.tiptap-body .note-link) {
    display: inline-flex; align-items: center; padding: 0 6px; margin: 0 1px;
    border-radius: 6px; cursor: pointer;
    background: var(--accent-dim); color: var(--accent); font-weight: 500;
    text-decoration: none;
  }
  .tiptap-host :global(.tiptap-body .note-link::before) { content: '[['; opacity: 0.45; margin-right: 1px; }
  .tiptap-host :global(.tiptap-body .note-link::after) { content: ']]'; opacity: 0.45; margin-left: 1px; }
  .tiptap-host :global(.tiptap-body .note-link.ProseMirror-selectednode) { outline: 2px solid var(--accent); }
  .link-suggest {
    position: fixed; z-index: 4000; width: 260px; max-width: calc(100vw - 24px);
    list-style: none; padding: 4px; margin: 0;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,.35));
  }
  .link-suggest button {
    width: 100%; min-height: 36px; padding: 6px 8px; border-radius: 8px;
    display: flex; align-items: center; gap: 8px; text-align: left; font-size: 14px; color: var(--text-1);
  }
  .link-suggest button.on, .link-suggest button:hover { background: var(--accent-dim); }
  .link-suggest .material-symbols-rounded { font-size: 18px; color: var(--text-3); }
  .link-suggest .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tiptap-host :global(.tiptap-body hr) { border: none; border-top: 1px solid var(--border-strong); }
  .tiptap-host :global(.tiptap-body p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    color: var(--text-3);
    float: left;
    height: 0;
    pointer-events: none;
  }
</style>
