import { Node, mergeAttributes } from '@tiptap/core';

// Block nodes that exist only in the `note` editor profile (material notes).
// The specs here are headless: schema builders for seeding, export and Agent
// reads use them as-is, and the note editor attaches its React node view to
// MaterialEmbed separately so this module never imports React.

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the selected blocks in a callout, or lift them out of one. */
      toggleCallout: () => ReturnType;
    };
    materialEmbed: {
      /** Insert a reference to an image or PDF material at the selection. */
      insertMaterialEmbed: (libraryItemId: string) => ReturnType;
    };
  }
}

/** A washed, bordered aside. No inset accent bar (see AGENTS.md UI rules). */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'paragraph+',
  defining: true,

  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['aside', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'note-callout' }), 0];
  },

  addCommands() {
    return {
      toggleCallout:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name),
    };
  },
});

/**
 * A reference to another material. It never carries bytes: the image or PDF
 * stays an ordinary `library_item` that owns its asset, so asset ownership is
 * still expressed exactly once (docs/local-assets.md).
 */
export const MaterialEmbed = Node.create({
  name: 'materialEmbed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      libraryItemId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-library-item-id'),
        renderHTML: (attributes) =>
          attributes.libraryItemId ? { 'data-library-item-id': attributes.libraryItemId } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-material-embed]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes(HTMLAttributes, { 'data-material-embed': '' })];
  },

  addCommands() {
    return {
      insertMaterialEmbed:
        (libraryItemId) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { libraryItemId } }),
    };
  },
});
