/**
 * Build the per-debounce shared block context that every Copilot capability
 * consumes. Replaces the old "focus block + N neighbors" model used while
 * Copilot was still scanning one block at a time.
 *
 * The dirty queue (see session-store) tells us which blocks the user has
 * actually touched since the last successful scan. This builder turns those
 * block ids into ordered text snippets via the same Tiptap doc walk the
 * old block-context selector used, dropping blocks that have since
 * disappeared (deletion, undo).
 *
 * priorSections is intentionally empty here — PR C wires up the
 * block_section repo read + hash validation. Keeping the field on the
 * shape lets capability code commit against the final interface today.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isBlockType } from '../extensions/block-id';
import type { BaseBlockContext, BlockSnippet, PriorSectionSnippet } from '../ai/context/types';

export interface BuildBaseBlockContextInput {
  editor: Editor;
  chapterId: string;
  /** Block ids the dirty queue says were edited this session. */
  dirtyBlockIds: Iterable<string>;
}

export function buildBaseBlockContext(
  input: BuildBaseBlockContextInput,
): BaseBlockContext | null {
  const dirty = new Set(input.dirtyBlockIds);
  if (dirty.size === 0) return null;

  // Walk the doc once, collecting every dirty block in document order. Any
  // dirty id that no longer exists in the doc was deleted/undone — silently
  // skipped (its dirty entry can stay; subsequent drain will remove it).
  const collected: Array<{ id: string; node: PMNode; docIndex: number }> = [];
  let docIndex = 0;
  input.editor.state.doc.descendants((node) => {
    if (!isBlockType(node.type.name)) return undefined;
    const id = node.attrs?.id as string | null | undefined;
    if (!id) return undefined;
    if (dirty.has(id)) {
      collected.push({ id, node, docIndex });
    }
    docIndex += 1;
    // Mirror block-context.ts: don't recurse into a block we've already
    // counted — nested paragraphs inside a list item would otherwise be
    // hit twice with different parent attrs.
    return false;
  });

  const editedBlocks: BlockSnippet[] = collected
    .map((c, idx) => ({
      blockId: c.id,
      text: normalizeBlockText(c.node.textContent),
      // `offset` historically encoded distance from a single focus block.
      // Here it encodes order within the edited batch — what the prompt
      // sorts by when rendering recent edits. First edited block = 0.
      offset: idx,
    }))
    .filter((snip) => snip.text.length > 0);

  if (editedBlocks.length === 0) return null;

  // PR C fills this with hash-validated rolling summaries; PR B leaves it
  // empty so capabilities can ship against the final shape today.
  const priorSections: PriorSectionSnippet[] = [];

  return {
    chapterId: input.chapterId,
    editedBlocks,
    priorSections,
  };
}

function normalizeBlockText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}
