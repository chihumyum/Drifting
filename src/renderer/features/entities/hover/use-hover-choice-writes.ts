import { useCallback } from 'react';
import loglevel from 'loglevel';

import { isDrift, type BookNode } from '../../../domain/book-node';
import { actBoundDriftIds } from '../../../domain/book-act';
import { resolvePrimaryStorylineId } from '../../../domain/node-storyline-state';
import { useAuthStore } from '../../../store/auth';
import { useDataStore } from '../../../store/data-store';
import { useBookNode } from '../../../usecase/useBookNode';
import { useStoryline } from '../../../usecase/useStoryline';

const log = loglevel.getLogger('hover-choice-writes');
log.setLevel(loglevel.levels.ERROR);

/**
 * Puts a chapter on a storyline or takes it off, from its hover card's
 * 编辑故事线 section. The primary storyline stays primary while the chapter
 * keeps it; taking it off hands primary to the next one (none leaves the
 * chapter 未归属), as the storyline editor does.
 */
export function useChapterStorylineToggle(projectId: string | null | undefined) {
  const userId = useAuthStore((s) => s.user?.id);
  const { updateNode } = useBookNode({ projectId: projectId ?? '', userId: userId ?? '' });
  const { setNodeStorylines } = useStoryline({ projectId: projectId ?? '', userId: userId ?? '' });
  return useCallback((nodeId: string, storylineId: string) => {
    const state = useDataStore.getState();
    const valid = new Set(state.storylines.map((storyline) => storyline.id));
    const mapped = (state.nodeStorylineMapping[nodeId] ?? []).filter((id) => valid.has(id));
    const primary = resolvePrimaryStorylineId(state.primaryStorylineByNode[nodeId], mapped);
    const ordered = primary ? [primary, ...mapped.filter((id) => id !== primary)] : mapped;
    const next = ordered.includes(storylineId)
      ? ordered.filter((id) => id !== storylineId)
      : [...ordered, storylineId];
    const nextPrimary = next[0] ?? null;
    void (async () => {
      if (nextPrimary !== (primary ?? null)) await updateNode(nodeId, { mainStorylineId: nextPrimary });
      await setNodeStorylines(nodeId, next);
    })().catch((error: unknown) => log.error('Failed to update chapter storylines:', error));
  }, [setNodeStorylines, updateNode]);
}

/** A chapter's storylines, primary first: what its 编辑故事线 section ticks. */
export function chapterStorylineIds(nodeId: string): string[] {
  const state = useDataStore.getState();
  const valid = new Set(state.storylines.map((storyline) => storyline.id));
  const mapped = (state.nodeStorylineMapping[nodeId] ?? []).filter((id) => valid.has(id));
  const primary = resolvePrimaryStorylineId(state.primaryStorylineByNode[nodeId], mapped);
  return primary ? [primary, ...mapped.filter((id) => id !== primary)] : mapped;
}

/**
 * Drifts free to bind to a marker or an act (not anchored by either yet,
 * binding is exclusive), most recently touched first, as the bind picker
 * lists them. Read when a card opens rather than subscribed: a timeline
 * should not re-render on every keystroke for a card that is not showing.
 */
export function bindableDriftsNow(): BookNode[] {
  const { bookNodes, bookActs, timelineMarkers } = useDataStore.getState();
  const bound = new Set<string>(actBoundDriftIds(bookActs));
  for (const marker of timelineMarkers) if (marker.driftNodeId) bound.add(marker.driftNodeId);
  return bookNodes
    .filter(isDrift)
    .filter((node) => !bound.has(node.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The colour of a drift's group, for its eddy. */
export function driftColorNow(drift: BookNode): string | undefined {
  if (!drift.driftGroupId) return undefined;
  return useDataStore.getState().driftGroups.find((group) => group.id === drift.driftGroupId)?.color ?? undefined;
}
