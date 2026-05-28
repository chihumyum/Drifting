/**
 * Compose the per-fire BaseBlockContext from a coverage-map snapshot.
 *
 * Post PR D-1, this is mostly a thin assembly step:
 *   - read coverage map for the chapter (uncoveredBlocks + priorSections)
 *   - scan uncovered blocks for entityLink marks → mentionedElementIds
 *   - hand back as one object capabilities can consume directly
 *
 * The old "dirty queue" model is gone — capabilities don't get told which
 * blocks the user just touched. They see whatever is uncovered NOW. The
 * coverage map handles staleness (per-block hash), so a block edited 5
 * minutes ago and another edited just now both end up here together.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isBlockType } from '../extensions/block-id';
import { computeCoverageMap } from './coverage-map';
import type { BaseBlockContext } from '../ai/context/types';

export interface BuildBaseBlockContextInput {
  editor: Editor;
  chapterId: string;
}

export async function buildBaseBlockContext(
  input: BuildBaseBlockContextInput,
): Promise<BaseBlockContext | null> {
  const coverage = await computeCoverageMap({
    editor: input.editor,
    chapterId: input.chapterId,
  });
  if (coverage.uncoveredBlocks.length === 0) return null;

  // Walk the uncovered blocks again to extract entityLink marks. Cheap —
  // O(uncoveredBlocks × text-nodes-per-block); only marks with targetKind
  // === 'element' contribute.
  const uncoveredBlockIds = new Set(coverage.uncoveredBlocks.map((b) => b.blockId));
  const mentionedElementIds = new Set<string>();
  input.editor.state.doc.descendants((node: PMNode) => {
    if (!isBlockType(node.type.name)) return undefined;
    const id = node.attrs?.id as string | null | undefined;
    if (!id || !uncoveredBlockIds.has(id)) return undefined;
    node.descendants((child) => {
      if (!child.isText) return undefined;
      for (const mark of child.marks) {
        if (mark.type.name !== 'entityLink') continue;
        const targetKind = mark.attrs?.targetKind;
        const targetId = mark.attrs?.targetId;
        if (targetKind === 'element' && typeof targetId === 'string' && targetId) {
          mentionedElementIds.add(targetId);
        }
      }
      return undefined;
    });
    return false;
  });

  return {
    chapterId: input.chapterId,
    uncoveredBlocks: coverage.uncoveredBlocks,
    priorSections: coverage.priorSections,
    mentionedElementIds: [...mentionedElementIds],
  };
}
