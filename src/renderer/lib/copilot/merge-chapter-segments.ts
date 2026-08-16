/**
 * mergeChapterSegments (Task 5, part A) — when a chapter is finalized and
 * every block is covered, collapse the pile of small rolling segment summaries
 * into fewer, bigger ones. Greedy grouping by block count merges undersized
 * segments into their neighbors so the chapter's working memory (and the
 * reverse chapter summary that reads it) isn't fragmented into one-liners.
 *
 * Block_sections are regenerable artifacts, so this is safe to be destructive:
 * each merged group becomes one new section ('reverse-outline') and the
 * originals are deleted. Worst case on a bad merge, normal editing re-covers.
 *
 * No heading-aware path yet — block-count grouping is the general strategy the
 * spec emphasized ("过少的和邻近 segment 合并"); heading binning can layer on
 * later via extractOutline.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import loglevel from 'loglevel';
import { runStructured } from '../ai/run-structured';
import { segmentMergePrompt } from '../ai/prompts/templates/segment-merge';
import { isBlockType } from '../extensions/block-id';
import { computeBlockHashes } from './block-signature';
import type { BlockSection } from '../../domain/block-section';
import { useDataStore } from '../../store/data-store';
import { replaceBlockSectionsWithSync } from '../../usecase/synced-entity-commands';

const log = loglevel.getLogger('copilot:segment-merge');

/** Target block count per merged segment. Groups accrue until they reach it. */
const TARGET_BLOCKS_PER_SEGMENT = 20;

export async function mergeChapterSegments(params: {
  editor: Editor;
  projectId: string;
  chapterId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { editor, projectId, chapterId, signal } = params;

  // Doc-order index per block id (for ordering sections + union output).
  const orderByBlock = new Map<string, number>();
  let idx = 0;
  editor.state.doc.descendants((node: PMNode) => {
    if (!isBlockType(node.type.name)) return undefined;
    const id = node.attrs?.id as string | null | undefined;
    if (id) orderByBlock.set(id, idx++);
    return false;
  });

  const sections = useDataStore
    .getState()
    .blockSections.filter((s) => s.chapterId === chapterId)
    .slice()
    .sort((a, b) => minOrder(a, orderByBlock) - minOrder(b, orderByBlock));
  if (sections.length < 2) return; // nothing worth merging

  // Greedy grouping by block count; a small trailing remainder folds into the
  // previous group rather than surviving as a fragment.
  const groups: BlockSection[][] = [];
  let cur: BlockSection[] = [];
  let curCount = 0;
  for (const s of sections) {
    cur.push(s);
    curCount += s.blockIds.length;
    if (curCount >= TARGET_BLOCKS_PER_SEGMENT) {
      groups.push(cur);
      cur = [];
      curCount = 0;
    }
  }
  if (cur.length > 0) {
    if (groups.length > 0 && curCount < TARGET_BLOCKS_PER_SEGMENT / 2) {
      groups[groups.length - 1]!.push(...cur);
    } else {
      groups.push(cur);
    }
  }

  for (const group of groups) {
    if (signal?.aborted) return;
    if (group.length < 2) continue; // already adequately sized — leave as-is

    const unionIds = [...new Set(group.flatMap((s) => s.blockIds))]
      .filter((id) => orderByBlock.has(id))
      .sort((a, b) => (orderByBlock.get(a) ?? 0) - (orderByBlock.get(b) ?? 0));
    if (unionIds.length === 0) continue;

    let merged: string;
    try {
      const out = await runStructured(
        segmentMergePrompt,
        { summaries: group.map((s) => s.summary) },
        { signal, projectId },
      );
      merged = out.summary.trim();
    } catch (err) {
      log.info('[segment-merge] merge call failed, leaving group as-is', err);
      continue;
    }
    if (!merged) continue;

    // Recompute per-block hashes from current text so the merged section's
    // coverage validity matches the live doc.
    const texts = collectTexts(editor, unionIds);
    const finalIds = unionIds.filter((id) => texts.has(id));
    if (finalIds.length === 0) continue;
    const blockHashes = computeBlockHashes(finalIds, (id) => texts.get(id) ?? '');

    try {
      const created = await replaceBlockSectionsWithSync({
        projectId,
        chapterId,
        blockIds: finalIds,
        blockHashes,
        summary: merged,
        source: 'reverse-outline',
      }, group.map((old) => old.id));
      useDataStore.getState().addBlockSection(created);
      for (const old of group) {
        useDataStore.getState().removeBlockSection(old.id);
      }
      log.info(`[segment-merge] merged ${group.length} sections → 1 (${finalIds.length} blocks)`);
    } catch (err) {
      log.warn('[segment-merge] persist failed', err);
    }
  }
}

function minOrder(s: BlockSection, order: Map<string, number>): number {
  let m = Infinity;
  for (const id of s.blockIds) {
    const o = order.get(id);
    if (o !== undefined && o < m) m = o;
  }
  return m === Infinity ? Number.MAX_SAFE_INTEGER : m;
}

function collectTexts(editor: Editor, ids: string[]): Map<string, string> {
  const want = new Set(ids);
  const out = new Map<string, string>();
  editor.state.doc.descendants((node: PMNode) => {
    if (!isBlockType(node.type.name)) return undefined;
    const id = node.attrs?.id as string | null | undefined;
    if (id && want.has(id)) out.set(id, node.textContent.replace(/\s+/g, ' ').trim());
    return false;
  });
  return out;
}
