export const DEFAULT_STORYLINE_LANE_ID = '__default__';
export const UNAFFILIATED_STORYLINE_LANE_ID = '__unaffiliated__';

export type ChapterOrderField = 'bookOrder' | 'narrativeOrder';

interface CanDropChapterOnLaneInput {
  targetLaneId: string | null;
  fromDrawer: boolean;
  primaryStorylineId: string | null;
}

/**
 * Shared drop-target policy for Bottom Timeline and Storyline Graph.
 * Keeping this pure prevents the two desktop projections from drifting into
 * different membership rules as their visual layouts evolve independently.
 */
export function canDropChapterOnLane({
  targetLaneId,
  fromDrawer,
  primaryStorylineId,
}: CanDropChapterOnLaneInput): boolean {
  if (targetLaneId === null) return false;
  if (targetLaneId === DEFAULT_STORYLINE_LANE_ID) return true;
  if (targetLaneId === UNAFFILIATED_STORYLINE_LANE_ID) {
    return !fromDrawer || primaryStorylineId === null;
  }
  if (!fromDrawer || primaryStorylineId === null) return true;
  return targetLaneId === primaryStorylineId;
}

export const CHAPTER_DRAG_MIME = 'application/x-drifting-chapter';

/**
 * WebKit-backed desktop webviews require a non-empty DataTransfer payload for
 * a native HTML drag to remain active through dragover/drop. React state alone
 * is not a drag payload, so both chapter projections use this initializer.
 */
export function initializeChapterDrag(
  dataTransfer: DataTransfer,
  nodeId: string,
  dragImage?: HTMLElement,
): void {
  dataTransfer.effectAllowed = 'move';
  dataTransfer.setData('text/plain', nodeId);
  dataTransfer.setData(CHAPTER_DRAG_MIME, nodeId);
  if (dragImage) {
    const rect = dragImage.getBoundingClientRect();
    dataTransfer.setDragImage(dragImage, rect.width / 2, rect.height / 2);
  }
}

type ChapterDropUpdate = Partial<Record<ChapterOrderField, number>> & {
  mainStorylineId?: string | null;
};

interface CommitChapterLaneDropInput {
  nodeId: string;
  targetLaneId: string;
  targetOrder: number;
  orderField: ChapterOrderField;
  primaryStorylineId: string | null;
  membershipIds: readonly string[];
  updateNode: (nodeId: string, patch: ChapterDropUpdate) => Promise<unknown>;
  setNodeStorylines: (
    nodeId: string,
    storylineIds: string[],
    options?: { primaryStorylineId?: string | null },
  ) => Promise<unknown>;
}

/**
 * Persist one chapter drop using the same write ordering in both projections.
 * Primary/membership changes are applied before the final order patch so a
 * reroute cannot briefly snap back to the source lane.
 */
export async function commitChapterLaneDrop({
  nodeId,
  targetLaneId,
  targetOrder,
  orderField,
  primaryStorylineId,
  membershipIds,
  updateNode,
  setNodeStorylines,
}: CommitChapterLaneDropInput): Promise<void> {
  if (targetLaneId === DEFAULT_STORYLINE_LANE_ID) {
    await updateNode(nodeId, { [orderField]: targetOrder });
    return;
  }

  if (targetLaneId === UNAFFILIATED_STORYLINE_LANE_ID) {
    await updateNode(nodeId, { mainStorylineId: null });
    await setNodeStorylines(nodeId, []);
    await updateNode(nodeId, { [orderField]: targetOrder });
    return;
  }

  if (targetLaneId !== primaryStorylineId) {
    const nextMembershipIds = membershipIds.filter((id) => id !== primaryStorylineId);
    if (!nextMembershipIds.includes(targetLaneId)) nextMembershipIds.push(targetLaneId);
    await setNodeStorylines(nodeId, nextMembershipIds, {
      primaryStorylineId: targetLaneId,
    });
    await updateNode(nodeId, {
      [orderField]: targetOrder,
      mainStorylineId: targetLaneId,
    });
    return;
  }

  await updateNode(nodeId, { [orderField]: targetOrder });
}
