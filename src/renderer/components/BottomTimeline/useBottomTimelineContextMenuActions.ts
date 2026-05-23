import type { BookNode } from '../../domain/book-node';
import type {
  BottomTimelineContextMenuAction,
  BottomTimelineContextMenuState,
} from './types';

interface UseBottomTimelineContextMenuActionsParams {
  contextMenu: BottomTimelineContextMenuState | null;
  projectId: string | null | undefined;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  createNode: (input: {
    kind: 'chapter' | 'drift';
    bookOrder: number;
    mainStorylineId: string;
    position: { x: number; y: number };
  }) => Promise<BookNode>;
  setNodeStorylines: (nodeId: string, storylineIds: string[]) => Promise<void>;
  updateNode: (
    id: string,
    updates: Partial<BookNode> & { mainStorylineId?: string | null },
  ) => Promise<void>;
  navigateToNode: (nodeId: string) => void;
  onCloseMenu: () => void;
  onError: (message: string, error?: unknown) => void;
}

// Handles BottomTimeline-local context-menu actions only — the shared
// per-entity actions (delete, edit storylines, status flips, ...) flow
// through useEntityCellAction so the menu options stay in lockstep with
// EditorTopBar's three-dot menu.
export function useBottomTimelineContextMenuActions({
  contextMenu,
  projectId,
  scrollContainerRef,
  createNode,
  setNodeStorylines,
  updateNode,
  navigateToNode,
  onCloseMenu,
  onError,
}: UseBottomTimelineContextMenuActionsParams) {
  const handleContextMenuAction = async (action: BottomTimelineContextMenuAction) => {
    if (!contextMenu) return;

    const scrollContainer = scrollContainerRef.current;
    const savedScrollLeft = scrollContainer?.scrollLeft || 0;

    if (!projectId) {
      onError('No projectId found for context menu action');
      return;
    }

    try {
      switch (action) {
        case 'createChapterHere':
          if (
            contextMenu.type === 'storyline' &&
            contextMenu.storylineId &&
            contextMenu.position !== undefined
          ) {
            const newNode = await createNode({
              kind: 'chapter',
              bookOrder: contextMenu.position,
              mainStorylineId: contextMenu.storylineId,
              position: { x: 0, y: 0 },
            });
            navigateToNode(newNode.id);
          }
          break;

        case 'moveToUnaffiliated':
          if (contextMenu.type === 'node' && contextMenu.nodeId) {
            // Null primary first so setNodeStorylines doesn't auto-pin it
            // back into the membership set — same order the cross-storyline
            // drag handler uses.
            await updateNode(contextMenu.nodeId, { mainStorylineId: null });
            await setNodeStorylines(contextMenu.nodeId, []);
            if (scrollContainer) {
              requestAnimationFrame(() => {
                scrollContainer.scrollLeft = savedScrollLeft;
              });
            }
          }
          break;

        case 'detachFromNarrative':
          // Narrative-view only: clearing narrativeOrder removes the tile
          // from the storyline rows; the chapter resurfaces in the
          // "未放置" popover so the author can re-place it.
          if (contextMenu.type === 'node' && contextMenu.nodeId) {
            await updateNode(contextMenu.nodeId, { narrativeOrder: null });
            if (scrollContainer) {
              requestAnimationFrame(() => {
                scrollContainer.scrollLeft = savedScrollLeft;
              });
            }
          }
          break;
      }
    } catch (error) {
      onError('Context menu action failed:', error);
    } finally {
      onCloseMenu();
    }
  };

  return {
    handleContextMenuAction,
  };
}
