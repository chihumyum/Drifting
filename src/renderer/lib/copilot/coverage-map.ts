/**
 * Per-chapter coverage map: the single state object every Copilot capability
 * reads from at fire time.
 *
 * Replaces the old per-task dirty queue. A block in this chapter is either:
 *
 *   - COVERED   — some block_section row's stored hash matches its current
 *                 text. Its content is represented to capabilities via the
 *                 section's `summary` string (priorSections in baseContext).
 *
 *   - UNCOVERED — no valid section covers it (either: never summarized, OR
 *                 was summarized but the user has since edited it so the
 *                 stored hash no longer matches the current text). Capability
 *                 sees this block's full raw text in `editedBlocks`.
 *
 * Crucially, this is computed per-BLOCK not per-section. A 20-block section
 * with one edited block in the middle stays as a valid summary for the other
 * 19 blocks — only the edited block bubbles up into "uncovered". The single-
 * block edit doesn't cost the model 20 raw blocks of context.
 *
 * Stale eviction policy: when a section is fully invalidated (zero blocks
 * still match), we delete it from the repo / store / server. Partial
 * invalidation (some blocks ok, some not) is recorded only — the section
 * row stays, the changed blocks just show up uncovered. They'll either be
 * naturally re-covered when accumulated uncovered ≥ threshold triggers a
 * new summary, or stay uncovered if the user never writes enough more.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import loglevel from 'loglevel';
import { isBlockType } from '../extensions/block-id';
import type { BlockSnippet, PriorSectionSnippet } from '../ai/context/types';
import { computeBlockHash } from './block-signature';
import { useDataStore } from '../../store/data-store';
import { createBlockSectionRepository } from '../../sqlite-repo/block-section-repo';
import { syncBlockSectionDelete } from '../../usecase/sync-helpers';

const log = loglevel.getLogger('copilot:coverage');

export interface CoverageMap {
  /**
   * Blocks not currently covered by any valid section, in document order.
   * Capabilities consume this as the "what the user has been editing"
   * material — fed to prompts as raw text.
   */
  uncoveredBlocks: BlockSnippet[];
  /**
   * Sections that still cover at least one block (their summary is still
   * useful as historical context). Oldest first by createdAt.
   */
  priorSections: PriorSectionSnippet[];
}

export interface ComputeCoverageMapInput {
  editor: Editor;
  chapterId: string;
}

/**
 * Walk the editor doc, compute per-block hashes, compare with what each
 * section recorded, and split the chapter's blocks into covered / uncovered
 * via the rules in the file header. Fully-invalidated sections get evicted
 * as a side-effect.
 *
 * Idempotent for the read path (no state mutation if all sections are
 * valid). Cheap — O(blocks in chapter + sections in chapter) hash ops.
 */
export async function computeCoverageMap(
  input: ComputeCoverageMapInput,
): Promise<CoverageMap> {
  // 1. Walk the editor doc once, collecting all anchored blocks in order.
  const allBlocks: Array<{ blockId: string; text: string; docIndex: number }> = [];
  let docIndex = 0;
  input.editor.state.doc.descendants((node: PMNode) => {
    if (!isBlockType(node.type.name)) return undefined;
    const id = node.attrs?.id as string | null | undefined;
    if (!id) return undefined;
    allBlocks.push({
      blockId: id,
      text: normalizeBlockText(node.textContent),
      docIndex: docIndex++,
    });
    return false;
  });

  // 2. Pull this chapter's sections from the store, oldest first.
  const sections = useDataStore
    .getState()
    .blockSections.filter((s) => s.chapterId === input.chapterId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // 3. Build a current-hash lookup for every block (cheap, used by both
  //    section validation and uncovered emission).
  const currentHashByBlock = new Map<string, string>();
  for (const b of allBlocks) {
    currentHashByBlock.set(b.blockId, computeBlockHash(b.text));
  }

  // 4. Walk sections. For each: which of its blocks still match?
  //    - Fully matching: section is "valid" → contributes priorSection;
  //      its blockIds count as COVERED.
  //    - Partial match: section still contributes a priorSection (summary
  //      stays useful for the unchanged blocks). Blocks that DON'T match
  //      bubble up to uncovered for re-scanning.
  //    - Zero matches: section is fully stale, drop it.
  const coveredBlockIds = new Set<string>();
  const validPriorSections: PriorSectionSnippet[] = [];
  const toEvict: { id: string; projectId: string }[] = [];

  for (const section of sections) {
    let matchCount = 0;
    const matchingBlockIds: string[] = [];
    for (const bid of section.blockIds) {
      const stored = section.blockHashes[bid];
      const current = currentHashByBlock.get(bid);
      // Block missing from doc (deleted) counts as non-matching.
      if (stored !== undefined && current !== undefined && stored === current) {
        matchCount += 1;
        matchingBlockIds.push(bid);
      }
    }
    if (matchCount === 0) {
      toEvict.push({ id: section.id, projectId: section.projectId });
      continue;
    }
    validPriorSections.push({
      blockIds: matchingBlockIds,
      summary: section.summary,
    });
    for (const bid of matchingBlockIds) coveredBlockIds.add(bid);
  }

  // 5. Uncovered = all blocks (in doc order) minus covered, with non-empty
  //    text. Empty blocks are skipped — they have no signal for scanning.
  //    `offset` is the doc index for stable ordering across prompts.
  const uncoveredBlocks: BlockSnippet[] = allBlocks
    .filter((b) => !coveredBlockIds.has(b.blockId) && b.text.length > 0)
    .map((b) => ({ blockId: b.blockId, text: b.text, offset: b.docIndex }));

  // 6. Best-effort eviction of fully-stale sections. Run after the read so
  //    even if eviction fails, the caller already has a coherent coverage
  //    snapshot. Fire-and-forget at the per-row level — one failure doesn't
  //    block the rest.
  if (toEvict.length > 0) {
    log.info(`[copilot:coverage] evicting ${toEvict.length} fully-stale section(s)`);
    const repo = createBlockSectionRepository();
    for (const target of toEvict) {
      try {
        await repo.delete(target.id);
        useDataStore.getState().removeBlockSection(target.id);
        syncBlockSectionDelete(target.id, target.projectId);
      } catch (err) {
        log.info(`[copilot:coverage] evict ${target.id.slice(0, 8)} failed`, err);
      }
    }
  }

  return { uncoveredBlocks, priorSections: validPriorSections };
}

function normalizeBlockText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}
