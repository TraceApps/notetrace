/**
 * note-link-extension.js: [[Note title]] links in the editor.
 *
 * In Markdown a link is plain `[[Title]]`, so notes stay portable (the same
 * syntax Obsidian and other apps use). In the editor it shows as a chip; a
 * tap opens the note. Typing `[[Title]]` turns into a link as the closing
 * brackets go in; typing `[[` alone opens title suggestions (TipTapEditor).
 */
import { Node, InputRule, mergeAttributes } from '@tiptap/core';

export const LINK_RE = /\[\[([^[\]\n]{1,200})\]\]/g;

/** Titles a Markdown body links to, trimmed, de-duplicated (case-insensitive). */
export function linkedTitles(md) {
  const seen = new Map();
  for (const m of String(md || '').matchAll(LINK_RE)) {
    const t = m[1].trim();
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()];
}

export const NoteLink = Node.create({
  name: 'noteLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { onOpen: null };
  },

  addAttributes() {
    return { title: { default: '' } };
  },

  parseHTML() {
    return [{ tag: 'span[data-note-link]', getAttrs: (el) => ({ title: el.getAttribute('data-note-link') || '' }) }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-note-link': node.attrs.title, class: 'note-link', role: 'link', tabindex: '0' }), node.attrs.title];
  },

  renderText({ node }) {
    return `[[${node.attrs.title}]]`;
  },

  markdownTokenName: 'noteLink',

  markdownTokenizer: {
    name: 'noteLink',
    level: 'inline',
    start(src) {
      return src.indexOf('[[');
    },
    tokenize(src) {
      const m = /^\[\[([^[\]\n]{1,200})\]\]/.exec(src);
      if (!m || !m[1].trim()) return;
      return { type: 'noteLink', raw: m[0], title: m[1].trim() };
    },
  },

  parseMarkdown(token) {
    return { type: 'noteLink', attrs: { title: token.title } };
  },

  renderMarkdown(node) {
    return `[[${node.attrs?.title || ''}]]`;
  },

  addInputRules() {
    // Replace the whole `[[Title]]` (nodeInputRule would keep the brackets
    // around the node, since it only swaps the captured group).
    const type = this.type;
    return [
      new InputRule({
        find: /\[\[([^[\]\n]{1,200})\]\]$/,
        handler: ({ state, range, match }) => {
          const title = match[1].trim();
          if (!title) return null;
          state.tr.replaceWith(range.from, range.to, type.create({ title }));
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [];
  },
});
