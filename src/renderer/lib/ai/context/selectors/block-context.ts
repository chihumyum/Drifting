/**
 * Block-context selector — given an active Tiptap editor and a block id,
 * extract the focus block's text plus N surrounding blocks. Used by the
 * element-candidate context builder to feed the model just enough narrative
 * context to disambiguate "is this a proper noun or a common word?".
 *
 * Walks the ProseMirror document directly (not the JSON), which is faster
 * and gives stable text concatenation via `block.textContent`.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isBlockType } from '../../../extensions/block-id';
import type { BlockSnippet } from '../types';

export interface ExtractBlockContextOptions {
  /** How many blocks before the focus to include. Default 2. */
  before?: number;
  /** How many blocks after the focus to include. Default 2. */
  after?: number;
}

export interface BlockContextResult {
  focus: BlockSnippet;
  surrounding: BlockSnippet[];
}

/**
 * Find the focus block by id, then walk siblings in document order to gather
 * N before and N after. Returns null if the block can't be located (likely
 * the block id is stale or the editor has been swapped out).
 */
export function extractBlockContext(
  editor: Editor,
  focusBlockId: string,
  options: ExtractBlockContextOptions = {},
): BlockContextResult | null {
  const before = options.before ?? 2;
  const after = options.after ?? 2;

  // Collect every block-typed node with an id, in document order. The doc
  // can be deeply nested (lists, blockquotes), but we treat anchored blocks
  // as a flat sequence — that's the same model BlockId / CommentRail use.
  const blocks: Array<{ id: string; node: PMNode }> = [];
  editor.state.doc.descendants((node) => {
    if (!isBlockType(node.type.name)) return undefined;
    const id = node.attrs?.id as string | null | undefined;
    if (!id) return undefined;
    blocks.push({ id, node });
    // Don't recurse into a block we've already counted — child paragraphs
    // inside a list item would otherwise be picked up twice. Returning
    // false from descendants() skips this subtree.
    return false;
  });

  const focusIdx = blocks.findIndex((b) => b.id === focusBlockId);
  if (focusIdx === -1) return null;

  const focus: BlockSnippet = {
    blockId: blocks[focusIdx]!.id,
    text: normalizeBlockText(blocks[focusIdx]!.node.textContent),
    offset: 0,
  };

  const surrounding: BlockSnippet[] = [];
  for (let i = Math.max(0, focusIdx - before); i < focusIdx; i++) {
    surrounding.push({
      blockId: blocks[i]!.id,
      text: normalizeBlockText(blocks[i]!.node.textContent),
      offset: i - focusIdx,
    });
  }
  for (let i = focusIdx + 1; i <= Math.min(blocks.length - 1, focusIdx + after); i++) {
    surrounding.push({
      blockId: blocks[i]!.id,
      text: normalizeBlockText(blocks[i]!.node.textContent),
      offset: i - focusIdx,
    });
  }

  return { focus, surrounding };
}

/**
 * Resolve the block id at the editor's current cursor position. Returns null
 * if the cursor isn't inside an anchored block (rare; would mean the BlockId
 * extension hasn't caught up yet).
 */
export function getBlockIdAtCursor(editor: Editor): string | null {
  const { selection } = editor.state;
  const resolved = editor.state.doc.resolve(selection.from);
  for (let depth = resolved.depth; depth >= 0; depth--) {
    const node = resolved.node(depth);
    if (!isBlockType(node.type.name)) continue;
    const id = node.attrs?.id as string | null | undefined;
    if (id) return id;
  }
  return null;
}

function normalizeBlockText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}
