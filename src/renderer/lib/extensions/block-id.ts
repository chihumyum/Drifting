import { Extension } from '@tiptap/core';
import { isHistoryTransaction } from '@tiptap/pm/history';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { v7 as uuidv7 } from 'uuid';

// Nodes that can be anchor targets for inline references and patches. Lists
// themselves remain containers; their individual listItem is the anchorable
// unit used by comments and references.
const ANCHORABLE_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
]);

// Agent prose commands snapshot every top-level ProseMirror child. Container
// and separator nodes therefore also need durable identity even though they
// are not valid inline-reference anchors.
const IDENTIFIED_BLOCK_TYPES = new Set([
  ...ANCHORABLE_BLOCK_TYPES,
  'bulletList',
  'orderedList',
  'horizontalRule',
]);

export const BlockIdPluginKey = new PluginKey('blockId');

const META_FLAG = 'blockId';

// Walk the document and assign ids to any block that is missing one or that
// shares an id with an earlier block (the duplicate case appears immediately
// after a split: ProseMirror keeps the original attrs on both halves).
function ensureBlockIds(state: EditorState): Transaction | null {
  let tr = state.tr;
  let modified = false;
  const seen = new Set<string>();

  state.doc.descendants((node, pos) => {
    if (!IDENTIFIED_BLOCK_TYPES.has(node.type.name)) return;
    const currentId = node.attrs.id as string | null | undefined;
    if (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      return;
    }
    const newId = uuidv7();
    seen.add(newId);
    tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: newId });
    modified = true;
  });

  if (!modified) return null;
  tr.setMeta(META_FLAG, true);
  tr.setMeta('addToHistory', false);
  return tr;
}

export const BlockId = Extension.create({
  name: 'blockId',

  addGlobalAttributes() {
    return [
      {
        types: Array.from(IDENTIFIED_BLOCK_TYPES),
        attributes: {
          id: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-block-id'),
            renderHTML: (attributes) =>
              attributes.id ? { 'data-block-id': attributes.id } : {},
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: BlockIdPluginKey,

        // Initial pass on editor mount: fill in missing ids in existing content.
        view(editorView: EditorView) {
          // Defer to next tick so the editor is fully wired up first.
          queueMicrotask(() => {
            const tr = ensureBlockIds(editorView.state);
            if (tr) editorView.dispatch(tr);
          });
          return {};
        },

        // On every doc change, assign ids to newly created blocks and resolve
        // duplicates created by splits.
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((t) => t.docChanged)) return null;
          // Avoid recursion if our own transaction is being processed.
          if (transactions.some((t) => t.getMeta(META_FLAG))) return null;
          // Don't re-run during yjs undo/redo or while applying a remote
          // sync update — both of those produce intermediate "duplicate id"
          // states that would otherwise loop us into fighting undo.
          for (const t of transactions) {
            if (isHistoryTransaction(t)) return null;
            if (t.getMeta('y-undo$') || t.getMeta('y-sync$')) return null;
          }
          return ensureBlockIds(newState);
        },
      }),
    ];
  },
});

// Exposed so the projection service can introspect which node types are
// considered anchorable blocks.
export function isBlockType(typeName: string): boolean {
  return ANCHORABLE_BLOCK_TYPES.has(typeName);
}
