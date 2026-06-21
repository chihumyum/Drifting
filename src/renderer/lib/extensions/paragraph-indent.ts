import { Extension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';

// Block-level indent for the novel-writing surface.
//
// Lists are disabled in this editor (StarterKit bulletList/orderedList/
// listKeymap: false), which also removed the only thing that used to bind Tab
// (listKeymap's indent-list-item). With nothing consuming Tab, ProseMirror let
// it fall through to the browser default, which moves focus out of the
// contenteditable — the "Tab loses focus" bug.
//
// This extension makes Tab a first-class block indent instead: a per-block
// `indent` LEVEL attribute (0..maxLevel) rendered as a left margin. Tab raises
// the level on every block the selection touches, Shift-Tab lowers it. Tab is
// ALWAYS consumed (even at the clamp ceiling / on an empty doc) so the editor
// can never blur to the next focusable element.
//
// This is orthogonal to the global first-line indent (--editor-indent, a
// uniform text-indent on every paragraph). An indented block keeps its
// first-line indent and simply shifts right as a whole.

export interface ParagraphIndentOptions {
  /** Block types that accept an indent level. */
  types: string[];
  /** Maximum indent level, so Tab-mashing can't push prose off the page. */
  maxLevel: number;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphIndent: {
      /** Raise the indent level of every block in the selection by one. */
      indentBlock: () => ReturnType;
      /** Lower the indent level of every block in the selection by one. */
      outdentBlock: () => ReturnType;
    };
  }
}

export const ParagraphIndent = Extension.create<ParagraphIndentOptions>({
  name: 'paragraphIndent',

  addOptions() {
    return {
      types: ['paragraph', 'heading', 'blockquote'],
      maxLevel: 8,
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => {
              const value = Number(element.getAttribute('data-indent'));
              return Number.isFinite(value) && value > 0 ? value : 0;
            },
            renderHTML: (attributes) => {
              const level = (attributes.indent as number) || 0;
              if (!level) return {};
              // Both a data attribute (so it round-trips through parseHTML) and
              // an inline logical margin. The per-level width comes from a CSS
              // variable (--editor-indent-step, set from the editor settings),
              // so changing the step reflows every indented block instantly —
              // no editor rebuild. mergeAttributes concatenates this `style`
              // with any other contributor (e.g. TextAlign's text-align).
              return {
                'data-indent': String(level),
                style: `margin-inline-start: calc(var(--editor-indent-step, 2em) * ${level})`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    // Shift every indentable block touched by the selection by `delta`,
    // clamped to [0, maxLevel]. setNodeMarkup preserves node size, so the
    // positions gathered from the original doc stay valid as we stack edits
    // onto the same transaction.
    const shiftIndent =
      (delta: number) =>
      ({ state, dispatch }: { state: EditorState; dispatch?: (tr: Transaction) => void }) => {
        const { from, to } = state.selection;
        const { types, maxLevel } = this.options;
        let tr = state.tr;
        let changed = false;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!types.includes(node.type.name)) return;
          const current = (node.attrs.indent as number) || 0;
          const next = Math.min(maxLevel, Math.max(0, current + delta));
          if (next !== current) {
            tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
            changed = true;
          }
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      };

    return {
      indentBlock: () => shiftIndent(1),
      outdentBlock: () => shiftIndent(-1),
    };
  },

  addKeyboardShortcuts() {
    return {
      // Always return true so Tab is swallowed and the editor never blurs —
      // even when already at maxLevel or in an empty doc.
      Tab: () => {
        this.editor.commands.indentBlock();
        return true;
      },
      'Shift-Tab': () => {
        this.editor.commands.outdentBlock();
        return true;
      },
    };
  },
});
