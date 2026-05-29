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
import { useDataStore } from '../../store/data-store';
import type { BaseBlockContext, BlockSnippet, PriorSectionSnippet } from '../ai/context/types';

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

/**
 * Build a SELECTION-scoped BaseBlockContext (Task 6): instead of the rolling
 * coverage view, the capability sees exactly the blocks the user selected as
 * `uncoveredBlocks`, plus every segment those blocks fall into as
 * `priorSections` (so the selection's summaries come along). Used when the
 * user right-clicks / ⌘I's a selection and runs a capability on it.
 *
 * Synchronous (no eviction side-effects) — pure read of the doc + section
 * store. Returns null if the selection has no non-empty text blocks.
 */
export function buildSelectionBlockContext(
  editor: Editor,
  chapterId: string,
  selectedBlockIds: string[],
): BaseBlockContext | null {
  if (selectedBlockIds.length === 0) return null;
  const idSet = new Set(selectedBlockIds);

  const uncoveredBlocks: BlockSnippet[] = [];
  const mentionedElementIds = new Set<string>();
  let docIndex = 0;
  editor.state.doc.descendants((node: PMNode) => {
    if (!isBlockType(node.type.name)) return undefined;
    const id = node.attrs?.id as string | null | undefined;
    const myIndex = docIndex++;
    if (!id || !idSet.has(id)) return false;
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    if (text.length > 0) uncoveredBlocks.push({ blockId: id, text, offset: myIndex });
    node.descendants((child) => {
      if (!child.isText) return undefined;
      for (const mark of child.marks) {
        if (
          mark.type.name === 'entityLink' &&
          mark.attrs?.targetKind === 'element' &&
          typeof mark.attrs?.targetId === 'string' &&
          mark.attrs.targetId
        ) {
          mentionedElementIds.add(mark.attrs.targetId);
        }
      }
      return undefined;
    });
    return false;
  });
  if (uncoveredBlocks.length === 0) return null;

  const priorSections: PriorSectionSnippet[] = useDataStore
    .getState()
    .blockSections.filter(
      (s) => s.chapterId === chapterId && s.blockIds.some((b) => idSet.has(b)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s) => ({ blockIds: s.blockIds, summary: s.summary }));

  return {
    chapterId,
    uncoveredBlocks,
    priorSections,
    mentionedElementIds: [...mentionedElementIds],
  };
}

/**
 * Regen decision for Task 6: should we produce a fresh segment summary after
 * running a capability over a selection? "Contained in one segment" → no
 * (that segment's summary already covers it). Spans multiple segments, or
 * isn't covered by any → yes (a span-scoped summary is worth having).
 */
export function selectionWarrantsSummaryRegen(
  chapterId: string,
  selectedBlockIds: string[],
): boolean {
  if (selectedBlockIds.length === 0) return false;
  const idSet = new Set(selectedBlockIds);
  const hit = useDataStore
    .getState()
    .blockSections.filter((s) => s.chapterId === chapterId && s.blockIds.some((b) => idSet.has(b)));
  if (hit.length > 1) return true; // spans multiple segments
  if (hit.length === 0) return true; // not covered by any segment yet
  // Exactly one segment touched — regen only if the selection spills outside it.
  const segIds = new Set(hit[0]!.blockIds);
  return !selectedBlockIds.every((b) => segIds.has(b));
}
