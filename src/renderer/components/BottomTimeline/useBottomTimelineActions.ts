import type { BookNode } from '../../domain/book-node';
import type { BottomTimelineNodeAction } from './types';

interface UseBottomTimelineActionsParams {
  projectId: string | null | undefined;
  orderField: 'bookOrder' | 'narrativeOrder';
  nextBookOrder: number;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  createNode: (input: {
    kind: 'chapter' | 'drift';
    bookOrder: number;
    narrativeOrder?: number;
    mainStorylineId: string | null;
    position: { x: number; y: number };
  }) => Promise<BookNode>;
  setNodeStorylines: (nodeId: string, storylineIds: string[]) => Promise<void>;
  updateNode: (
    id: string,
    updates: Partial<BookNode> & { mainStorylineId?: string | null },
  ) => Promise<void>;
  navigateToNode: (nodeId: string) => void;
  onError: (message: string, error?: unknown) => void;
}

// BottomTimeline-local actions only: creating a chapter at a spot on a lane
// (double-click on empty track, or the storyline card's 新建章节) and the
// clip card's timeline-only entries. The shared per-entity actions (delete,
// edit storylines, status flips, ...) flow through useEntityCellAction so
// they stay in lockstep with EditorTopBar's ⋯ menu.
export function useBottomTimelineActions({
  projectId,
  orderField,
  nextBookOrder,
  scrollContainerRef,
  createNode,
  setNodeStorylines,
  updateNode,
  navigateToNode,
  onError,
}: UseBottomTimelineActionsParams) {
  // `order` is on the active axis. A lane with no storyline behind it (本书 /
  // 未归属) creates a chapter without a primary storyline.
  const createChapterAt = async (storylineId: string | null, order: number) => {
    if (!projectId) {
      onError('No projectId found for timeline chapter creation');
      return;
    }
    try {
      const newNode = await createNode({
        kind: 'chapter',
        bookOrder: orderField === 'bookOrder' ? order : nextBookOrder,
        ...(orderField === 'narrativeOrder' ? { narrativeOrder: order } : {}),
        mainStorylineId: storylineId,
        position: { x: 0, y: 0 },
      });
      navigateToNode(newNode.id);
    } catch (error) {
      onError('Failed to create a chapter on the timeline:', error);
    }
  };

  const runNodeAction = async (action: BottomTimelineNodeAction, nodeId: string) => {
    if (!projectId) {
      onError('No projectId found for timeline action');
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    const savedScrollLeft = scrollContainer?.scrollLeft || 0;
    try {
      if (action === 'moveToUnaffiliated') {
        // Null primary first so setNodeStorylines doesn't auto-pin it
        // back into the membership set — same order the cross-storyline
        // drag handler uses.
        await updateNode(nodeId, { mainStorylineId: null });
        await setNodeStorylines(nodeId, []);
      } else {
        // Clearing narrativeOrder removes the tile from the storyline rows;
        // the chapter resurfaces in the "未放置" popover for re-placing.
        await updateNode(nodeId, { narrativeOrder: null });
      }
      if (scrollContainer) {
        requestAnimationFrame(() => {
          scrollContainer.scrollLeft = savedScrollLeft;
        });
      }
    } catch (error) {
      onError('Timeline action failed:', error);
    }
  };

  return { createChapterAt, runNodeAction };
}
