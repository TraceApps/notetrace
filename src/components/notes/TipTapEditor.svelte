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
   *
   * Typing `/` at the start of a line or after a space shows commands:
   * formatting runs here; note-level actions (checklist, image, voice note,
   * reminder) are emitted as `slash` for the note editor to handle.
   */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import { TaskList, TaskItem } from '@tiptap/extension-list';
  import Highlight from '@tiptap/extension-highlight';
  import { promptDialog } from '../../stores/confirmDialog.js';
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
  /** Note-level slash commands the parent handles: 'checklist' | 'image' | 'file' | 'voice' | 'reminder'. */
  export let slashActions = [];

  const dispatch = createEventDispatcher();
  let el;
  let editor = null;
  let lastEmitted = value;
  let active = {};

  // [[ suggestions and / commands
  let suggest = null;   // { mode: 'link' | 'slash', query, from, to, x, y }
  let suggestIndex = 0;
  $: suggestions = !suggest ? [] : suggest.mode === 'slash' ? _slashMatches(suggest.query, slashActions) : _matches(suggest.query);

  const SLASH = [
    { key: 'todo',      icon: 'check_box',            words: 'todo checkbox check tick task' },
    { key: 'checklist', icon: 'checklist',            words: 'checklist list convert tasks', parent: true },
    { key: 'h1',        icon: 'format_h1',            words: 'heading title h1 large' },
    { key: 'h2',        icon: 'format_h2',            words: 'heading subtitle h2 medium' },
    { key: 'h3',        icon: 'format_h3',            words: 'heading h3 small' },
    { key: 'bullet',    icon: 'format_list_bulleted', words: 'bullet list unordered' },
    { key: 'numbered',  icon: 'format_list_numbered', words: 'numbered list ordered' },
    { key: 'highlight', icon: 'ink_highlighter',      words: 'highlight marker mark' },
    { key: 'quote',     icon: 'format_quote',         words: 'quote blockquote' },
    { key: 'code',      icon: 'code_blocks',          words: 'code block snippet' },
    { key: 'divider',   icon: 'horizontal_rule',      words: 'divider line rule separator' },
    { key: 'link',      icon: 'add_link',             words: 'link note wiki' },
    { key: 'date',      icon: 'today',                words: 'date today now' },
    { key: 'time',      icon: 'schedule',             words: 'time now clock' },
    { key: 'image',     icon: 'add_photo_alternate',  words: 'image photo picture', parent: true },
    { key: 'file',      icon: 'attach_file',          words: 'file attach attachment pdf document', parent: true },
    { key: 'drawing',   icon: 'draw',                 words: 'drawing draw sketch whiteboard handwriting', parent: true },
    { key: 'voice',     icon: 'mic',                  words: 'voice record audio', parent: true },
    { key: 'reminder',  icon: 'notification_add',     words: 'reminder remind alarm', parent: true },
  ];
  function _slashMatches(query, actions) {
    const q = query.trim().toLowerCase();
    return SLASH
      .filter(c => !c.parent || (actions || []).includes(c.key))
      .filter(c => !q || c.key.startsWith(q) || c.words.split(' ').some(w => w.startsWith(q)) || $_(`slash.${c.key}`).toLowerCase().includes(q))
      .slice(0, 10)
      .map(c => ({ ...c, slash: true }));
  }
  function runSlash(cmd) {
    const range = { from: suggest.from, to: suggest.to };
    suggest = null;
    const chain = editor.chain().focus().deleteRange(range);
    const now = new Date();
    switch (cmd.key) {
      case 'h1': chain.setHeading({ level: 1 }).run(); break;
      case 'h2': chain.setHeading({ level: 2 }).run(); break;
      case 'h3': chain.setHeading({ level: 3 }).run(); break;
      case 'todo': chain.toggleTaskList().run(); break;
      case 'highlight': chain.toggleHighlight().run(); break;
      case 'bullet': chain.toggleBulletList().run(); break;
      case 'numbered': chain.toggleOrderedList().run(); break;
      case 'quote': chain.toggleBlockquote().run(); break;
      case 'code': chain.toggleCodeBlock().run(); break;
      case 'divider': chain.setHorizontalRule().run(); break;
      case 'link': chain.insertContent('[[').run(); break;
      case 'date': chain.insertContent(now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + ' ').run(); break;
      case 'time': chain.insertContent(now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + ' ').run(); break;
      default: chain.run(); dispatch('slash', cmd.key);
    }
    refreshActive();
  }

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
    const s = !m && $from.parent.type.name !== 'codeBlock' ? before.match(/(?:^|\s)\/([a-zA-Z]{0,20})$/) : null;
    if (!m && !s) { suggest = null; return; }
    const coords = view.coordsAtPos(sel.from);
    const mode = m ? 'link' : 'slash';
    const query = m ? m[1] : s[1];
    const len = m ? m[0].length : s[1].length + 1;
    const changed = !suggest || suggest.mode !== mode || suggest.query !== query;
    suggest = { mode, query, from: sel.from - len, to: sel.from, x: coords.left, y: coords.bottom };
    if (changed) suggestIndex = 0;
    if (mode === 'slash' && !_slashMatches(query, slashActions).length) suggest = null;
  }

  function pickSuggestion(item) {
    if (!editor || !suggest || !item) return;
    if (item.slash) { runSlash(item); return; }
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
          heading: { levels: [1, 2, 3] },
          link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
        }),
        // Checkboxes inside a text note (- [ ] in Markdown) and ==highlighted== text.
        TaskList,
        TaskItem.configure({ nested: true }),
        // Not inclusive: typing on after a highlight, or a new line, isn't highlighted too.
        Highlight.extend({ inclusive: false }),
        Markdown,
        Placeholder.configure({ placeholder }),
        NoteLink,
      ],
      content: value || '',
      contentType: 'markdown',
      editorProps: {
        attributes: { class: 'tiptap-body', spellcheck: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': get(_)('notes.body_placeholder') },
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
      onSelectionUpdate: ({ editor: ed }) => { refreshActive(); _updateSuggest(ed); updateBubble(); },
      onFocus: () => { dispatch('focus'); updateBubble(); },
      onBlur: () => { dispatch('blur'); setTimeout(() => { suggest = null; if (!editor?.isFocused) bubble = null; }, 150); },
    });
    refreshActive();
    el.addEventListener('click', onLinkClick);
    window.addEventListener('scroll', hideBubble, true);
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

  // Scrolling moves the text out from under the bar; it comes back with the next selection change.
  const hideBubble = () => { if (bubble) bubble = null; };
  onDestroy(() => { el?.removeEventListener('click', onLinkClick); window.removeEventListener('scroll', hideBubble, true); editor?.destroy(); });

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
      underline: editor.isActive('underline'),
      link: editor.isActive('link'),
      h: editor.isActive('heading'),
      bullet: editor.isActive('bulletList'),
      ordered: editor.isActive('orderedList'),
      todo: editor.isActive('taskList'),
      highlight: editor.isActive('highlight'),
      quote: editor.isActive('blockquote'),
      code: editor.isActive('code'),
    };
    dispatch('formats', active);
  }

  export function focus() { editor?.commands.focus('end'); }

  /** The formatting tools, for a toolbar outside this component (the phone editor bar). */
  export function formatTools() { return tools.map(({ key, icon, label }) => ({ key, icon, label })); }
  export function format(key) { const t = tools.find(x => x.key === key); if (t) useTool(t); }
  function useTool(t) { if (t.action) t.action(); else run(t.fn); }

  function run(fn) {
    if (!editor) return;
    fn(editor.chain().focus()).run();
    refreshActive();
  }

  const tools = [
    { key: 'h', icon: 'title', label: 'notes.fmt_heading', fn: c => c.toggleHeading({ level: 2 }) },
    { key: 'bold', icon: 'format_bold', label: 'notes.fmt_bold', fn: c => c.toggleBold() },
    { key: 'italic', icon: 'format_italic', label: 'notes.fmt_italic', fn: c => c.toggleItalic() },
    { key: 'underline', icon: 'format_underlined', label: 'notes.fmt_underline', fn: c => c.toggleUnderline() },
    { key: 'strike', icon: 'strikethrough_s', label: 'notes.fmt_strike', fn: c => c.toggleStrike() },
    { key: 'highlight', icon: 'ink_highlighter', label: 'notes.fmt_highlight', fn: c => c.toggleHighlight() },
    { key: 'todo', icon: 'check_box', label: 'notes.fmt_checkboxes', fn: c => c.toggleTaskList() },
    { key: 'bullet', icon: 'format_list_bulleted', label: 'notes.fmt_bullets', fn: c => c.toggleBulletList() },
    { key: 'ordered', icon: 'format_list_numbered', label: 'notes.fmt_numbers', fn: c => c.toggleOrderedList() },
    { key: 'quote', icon: 'format_quote', label: 'notes.fmt_quote', fn: c => c.toggleBlockquote() },
    { key: 'code', icon: 'code', label: 'notes.fmt_code', fn: c => c.toggleCode() },
    { key: 'link', icon: 'link', label: 'notes.fmt_link', action: () => editLink() },
    { key: 'clear', icon: 'format_clear', label: 'notes.fmt_clear', fn: c => c.unsetAllMarks() },
    // Nesting uses Tab on a keyboard; a phone has no Tab key, so its bar gets buttons.
    { key: 'outdent', icon: 'format_indent_decrease', label: 'notes.fmt_outdent', phone: true, action: () => nest(false) },
    { key: 'indent', icon: 'format_indent_increase', label: 'notes.fmt_indent', phone: true, action: () => nest(true) },
  ];

  function nest(deeper) {
    if (!editor) return;
    const type = editor.isActive('taskItem') ? 'taskItem' : 'listItem';
    const chain = editor.chain().focus();
    (deeper ? chain.sinkListItem(type) : chain.liftListItem(type)).run();
    refreshActive();
  }

  // A link on the selected words (or the link the cursor is in); an empty address removes it.
  async function editLink() {
    if (!editor) return;
    if (editor.isActive('link')) editor.chain().extendMarkRange('link').run();
    const { from, to } = editor.state.selection;
    const current = editor.getAttributes('link').href || '';
    const answer = await promptDialog({
      title: get(_)(current ? 'notes.link_edit' : 'notes.link_add'),
      message: current ? get(_)('notes.link_remove_hint') : '',
      value: current, placeholder: 'https://', type: 'url', allowEmpty: !!current, maxlength: 2000,
      confirmText: get(_)('common.save'), cancelText: get(_)('common.cancel'),
    });
    if (answer == null) { editor.chain().focus().setTextSelection({ from, to }).run(); return; }
    const chain = editor.chain().focus().setTextSelection({ from, to });
    if (answer === '') { chain.extendMarkRange('link').unsetLink().run(); refreshActive(); return; }
    let href = answer.trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) href = (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(href) ? 'mailto:' : 'https://') + href;
    if (!/^(https?|mailto|tel):/i.test(href)) return;
    if (from === to) chain.insertContent({ type: 'text', text: answer.trim(), marks: [{ type: 'link', attrs: { href } }] }).run();
    else chain.extendMarkRange('link').setLink({ href }).run();
    refreshActive();
  }

  // The small bar over a selection: the formatting people reach for most.
  const BUBBLE_KEYS = ['bold', 'italic', 'underline', 'highlight', 'link', 'clear'];
  $: bubbleTools = tools.filter(t => BUBBLE_KEYS.includes(t.key));
  let bubble = null;   // { x, y, below }
  let fmtBarEl, bubbleEl;
  const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  function updateBubble() {
    if (!editor || !editor.isEditable || !editor.isFocused || suggest) { bubble = null; return; }
    const sel = editor.state.selection;
    if (sel.empty || sel.node || !editor.state.doc.textBetween(sel.from, sel.to, ' ').trim()) { bubble = null; return; }
    const view = editor.view;
    const a = view.coordsAtPos(sel.from), b = view.coordsAtPos(sel.to);
    const left = Math.min(a.left, b.left), right = Math.max(a.right, b.right);
    // Centred on the selection, but kept inside the note (the editor window, or the screen on a phone).
    const half = (bubbleEl?.offsetWidth || 250) / 2 + 8;
    const box = el.closest('.editor-panel')?.getBoundingClientRect() || { left: 0, right: window.innerWidth };
    const minX = Math.max(box.left, 0) + half, maxX = Math.min(box.right, window.innerWidth) - half;
    const x = maxX > minX ? Math.max(minX, Math.min(maxX, (left + right) / 2)) : window.innerWidth / 2;
    // On a touch screen the system's own copy/paste menu sits above the selection, so this goes below.
    const top = Math.min(a.top, b.top);
    // Also below when above would cover the formatting toolbar or run off the top.
    const barBottom = fmtBarEl?.getBoundingClientRect().bottom ?? 0;
    const below = coarse || top - 54 < Math.max(8, barBottom);
    bubble = { x, y: below ? Math.max(a.bottom, b.bottom) + 10 : top - 10, below };
  }
</script>

{#if showToolbar && editable}
  <div class="fmt-bar" bind:this={fmtBarEl} role="toolbar" aria-label={$_('notes.formatting')}>
    {#each tools.filter(t => !t.phone) as t (t.key)}
      <button type="button" class="fmt-btn" class:on={active[t.key]}
        title={$_(t.label)} aria-label={$_(t.label)} aria-pressed={!!active[t.key]}
        on:mousedown|preventDefault
        on:click={() => useTool(t)}>
        <span class="material-symbols-rounded">{t.icon}</span>
      </button>
    {/each}
  </div>
{/if}
{#if bubble && bubbleTools.length}
  <div class="sel-bubble" bind:this={bubbleEl} class:below={bubble.below} use:portal role="toolbar" aria-label={$_('notes.formatting')}
    style="left:{bubble.x}px; top:{bubble.y}px">
    {#each bubbleTools as t (t.key)}
      <button type="button" class="sel-btn" class:on={active[t.key]} title={$_(t.label)} aria-label={$_(t.label)} aria-pressed={!!active[t.key]}
        on:mousedown|preventDefault on:touchstart|preventDefault={() => useTool(t)} on:click={() => useTool(t)}>
        <span class="material-symbols-rounded">{t.icon}</span>
      </button>
    {/each}
  </div>
{/if}
<div class="tiptap-host" bind:this={el}></div>
{#if suggest && suggestions.length}
  <ul use:portal class="link-suggest" class:slash={suggest.mode === 'slash'} role="listbox"
    aria-label={suggest.mode === 'slash' ? $_('slash.title') : $_('note_links.suggestions')}
    style="left:{Math.min(suggest.x, window.innerWidth - 272)}px; {suggest.y + 360 > window.innerHeight && suggest.y > 380 ? `bottom:${window.innerHeight - suggest.y + 28}px` : `top:${suggest.y + 6}px`}">
    {#if suggest.mode === 'slash'}<li class="suggest-head" aria-hidden="true">{$_('slash.title')}</li>{/if}
    {#each suggestions as item, i}
      <li role="option" aria-selected={i === suggestIndex}>
        <button type="button" class:on={i === suggestIndex} on:mousedown|preventDefault={() => pickSuggestion(item)}>
          {#if item.slash}
            <span class="material-symbols-rounded">{item.icon}</span>
            <span class="t">{$_(`slash.${item.key}`)}</span>
          {:else}
            <span class="material-symbols-rounded">{item.create ? 'add_link' : 'description'}</span>
            <span class="t">{item.create ? $_('note_links.link_new', { values: { title: item.title } }) : item.title}</span>
          {/if}
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

  .sel-bubble {
    position: fixed; z-index: 3900; transform: translate(-50%, -100%);
    display: flex; gap: 2px; padding: 4px;
    background: var(--surface-1); border: 1px solid var(--border-strong); border-radius: 12px;
    box-shadow: var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.35));
    animation: sel-in 120ms ease-out;
  }
  .sel-bubble.below { transform: translate(-50%, 0); }
  .sel-btn { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border-radius: 8px; color: var(--text-1); }
  .sel-btn .material-symbols-rounded { font-size: 20px; }
  .sel-btn:hover { background: color-mix(in srgb, var(--text-1) 8%, transparent); }
  .sel-btn.on { background: var(--accent-dim); color: var(--accent); }
  @keyframes sel-in { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .sel-bubble { animation: none; } }
  :global(html.no-animations) .sel-bubble { animation: none; }

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
  .tiptap-host :global(.tiptap-body u) { text-decoration-thickness: 0.08em; text-underline-offset: 0.15em; }
  .tiptap-host :global(.tiptap-body ul),
  .tiptap-host :global(.tiptap-body ol) { padding-left: 1.4em; }
  .tiptap-host :global(.tiptap-body li + li) { margin-top: 0.2em; }
  .tiptap-host :global(.tiptap-body li p) { margin: 0; }
  /* Checkboxes in text: the box sits beside its line, and a ticked line fades. */
  .tiptap-host :global(.tiptap-body ul[data-type="taskList"]) { list-style: none; padding-left: 0.1em; }
  .tiptap-host :global(.tiptap-body ul[data-type="taskList"] ul[data-type="taskList"]) { padding-left: 1.5em; }
  .tiptap-host :global(.tiptap-body li[data-checked]) { display: flex; align-items: flex-start; gap: 0.55em; }
  .tiptap-host :global(.tiptap-body li[data-checked] > label) { flex: 0 0 auto; margin-top: 0.28em; user-select: none; }
  .tiptap-host :global(.tiptap-body li[data-checked] > div) { flex: 1; min-width: 0; }
  .tiptap-host :global(.tiptap-body li[data-checked] input[type="checkbox"]) {
    appearance: none; -webkit-appearance: none; margin: 0; cursor: pointer;
    width: 1.15em; height: 1.15em; border-radius: 0.3em;
    border: 2px solid var(--text-3); background: transparent; display: grid; place-content: center;
    transition: background var(--dur-fast), border-color var(--dur-fast);
  }
  .tiptap-host :global(.tiptap-body li[data-checked] input[type="checkbox"]::after) {
    content: ''; width: 0.32em; height: 0.6em; margin-top: -0.12em;
    border: solid var(--accent-text); border-width: 0 0.14em 0.14em 0; transform: rotate(45deg) scale(0);
    transition: transform 140ms ease;
  }
  .tiptap-host :global(.tiptap-body li[data-checked="true"] input[type="checkbox"]) { background: var(--accent); border-color: var(--accent); }
  .tiptap-host :global(.tiptap-body li[data-checked="true"] input[type="checkbox"]::after) { transform: rotate(45deg) scale(1); }
  .tiptap-host :global(.tiptap-body li[data-checked="true"] > div) { color: var(--text-3); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--text-3) 70%, transparent); }
  .tiptap-host :global(.tiptap-body mark) {
    background: color-mix(in srgb, #FFD54F 45%, transparent); color: inherit;
    border-radius: 0.2em; padding: 0 0.1em; box-decoration-break: clone; -webkit-box-decoration-break: clone;
  }
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
  .link-suggest.slash { max-height: 340px; overflow-y: auto; }
  .link-suggest.slash .material-symbols-rounded { color: var(--accent); }
  .suggest-head { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); padding: 6px 8px 4px; }
  .tiptap-host :global(.tiptap-body hr) { border: none; border-top: 1px solid var(--border-strong); }
  .tiptap-host :global(.tiptap-body p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    color: var(--text-3);
    float: left;
    height: 0;
    pointer-events: none;
  }
</style>
