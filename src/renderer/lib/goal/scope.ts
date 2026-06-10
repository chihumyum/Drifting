/**
 * /goal 一键演化 — deps discovery + scope (GOAL-EVOLVE.md §5 Phase 1).
 *
 * The mention backlinks are the CANDIDATE pool (chapters that name the element);
 * the critic later filters these to the chapters that actually contradict the new
 * setting — "candidate ≠ work-list". effectiveFromOrder is the timeline cutoff:
 * a base-field change → -Infinity (whole book); a patch → the patch's source order.
 */
import { createInlineMentionRepository } from '../../sqlite-repo/inline-mention-repo';
import { useDataStore } from '../../store/data-store';
import { isChapter } from '../../domain/book-node';
import type { ScopedChapter, ElementAppearance } from './types';

/** narrativeOrder (story time) ?? bookOrder (reading order) — same axis Shadow's
 *  effective-canon uses, so scope and effective_canon agree on "before/after". */
const timelineKey = (n: { narrativeOrder: number | null; bookOrder: number | null }): number =>
  n.narrativeOrder ?? n.bookOrder ?? Number.POSITIVE_INFINITY;

/** The element's appearances at/after the cutoff, each chapter carrying the block
 *  ids where it's mentioned. The primitive both scopeChapters and the essence
 *  worklist build on. `includeDrafts` mirrors arc derivation: false ⇒ only chapters
 *  the author marked 「finished」 are in scope (don't rewrite half-written drafts). */
export async function scopeAppearances(
  projectId: string,
  elementId: string,
  effectiveFromOrder: number,
  includeDrafts = false,
): Promise<ElementAppearance[]> {
  const backlinks = await createInlineMentionRepository().listBacklinksToTarget('element', elementId);
  const nodes = useDataStore.getState().bookNodes;
  const byChapter = new Map<string, { title: string; order: number; blockIds: Set<string> }>();
  for (const b of backlinks) {
    if (b.fromKind !== 'node') continue;
    const node = nodes.find((x) => x.id === b.fromId && x.projectId === projectId);
    if (!node) continue;
    // CHAPTERS only — drift nodes are free-floating inspiration, never auto-edited.
    // Must be an explicit kind gate: a drift's writingStatus ('drifting'/'resting')
    // only dodges the draft filter by accident, and 含草稿章 would let it through.
    if (!isChapter(node)) continue;
    if (!includeDrafts && node.writingStatus !== 'finished') continue;
    const order = timelineKey(node);
    if (order < effectiveFromOrder) continue;
    let entry = byChapter.get(b.fromId);
    if (!entry) {
      entry = { title: node.title, order, blockIds: new Set() };
      byChapter.set(b.fromId, entry);
    }
    if (b.fromBlockId) entry.blockIds.add(b.fromBlockId);
  }
  return [...byChapter.entries()]
    .map(([chapterId, { title, order, blockIds }]) => ({ chapterId, title, order, blockIds: [...blockIds] }))
    .sort((a, b) => a.order - b.order);
}

export async function scopeChapters(
  projectId: string,
  elementId: string,
  effectiveFromOrder: number,
  includeDrafts = false,
): Promise<ScopedChapter[]> {
  const apps = await scopeAppearances(projectId, elementId, effectiveFromOrder, includeDrafts);
  return apps.map(({ chapterId, title, order }) => ({ chapterId, title, order }));
}

/** Timeline position of a node — used to turn a patch's source chapter into an
 *  effectiveFromOrder. Unknown node ⇒ -Infinity (treat as whole-book). */
export function chapterOrder(chapterId: string): number {
  const n = useDataStore.getState().bookNodes.find((x) => x.id === chapterId);
  return n ? timelineKey(n) : Number.NEGATIVE_INFINITY;
}
