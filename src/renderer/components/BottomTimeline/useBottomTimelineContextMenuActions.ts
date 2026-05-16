import type { BookNode } from '../../domain/book-node';
import type { Storyline } from '../../domain/storyline';
import type {
  BottomTimelineContextMenuAction,
  BottomTimelineContextMenuState,
  TimelineNode,
} from './types';

interface UseBottomTimelineContextMenuActionsParams {
  contextMenu: BottomTimelineContextMenuState | null;
  projectId: string | null | undefined;
  currentRouteNodeId?: string;
  nodesWithStorylines: TimelineNode[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  nodeDefaultWidth: number;
  createNode: (input: {
    start: number;
    end: number;
    mainStorylineId: string;
    position: { x: number; y: number };
  }) => Promise<BookNode>;
  addNodeToStoryline: (nodeId: string, storylineId: string) => Promise<void>;
  getStorylinesByNode: (nodeId: string) => Promise<Storyline[]>;
  deleteNode: (nodeId: string) => Promise<void>;
  removeNodeFromStoryline: (nodeId: string, storylineId: string) => Promise<void>;
  setNodeStorylines: (nodeId: string, storylineIds: string[]) => Promise<void>;
  updateNode: (id: string, updates: Partial<BookNode>) => Promise<void>;
  navigateToNode: (nodeId: string) => void;
  navigateToHome: () => void;
  onCloseMenu: () => void;
  onError: (message: string, error?: unknown) => void;
}

export function useBottomTimelineContextMenuActions({
  contextMenu,
  projectId,
  currentRouteNodeId,
  nodesWithStorylines,
  scrollContainerRef,
  nodeDefaultWidth,
  createNode,
  addNodeToStoryline,
  getStorylinesByNode,
  deleteNode,
  removeNodeFromStoryline,
  setNodeStorylines,
  updateNode,
  navigateToNode,
  navigateToHome,
  onCloseMenu,
  onError,
}: UseBottomTimelineContextMenuActionsParams) {
  const handleContextMenuAction = async (action: BottomTimelineContextMenuAction) => {
    if (!contextMenu) return;

    const scrollContainer = scrollContainerRef.current;
    const savedScrollLeft = scrollContainer?.scrollLeft || 0;
    const shouldRestoreScroll = !['editChapter'].includes(action);

    if (!projectId) {
      onError('No projectId found for context menu action');
      return;
    }

    try {
      switch (action) {
        case 'createChapter':
          if (
            contextMenu.type === 'storyline' &&
            contextMenu.storylineId &&
            contextMenu.position !== undefined
          ) {
            const newNode = await createNode({
              start: contextMenu.position,
              end: contextMenu.position + nodeDefaultWidth,
              mainStorylineId: contextMenu.storylineId,
              position: { x: 0, y: 0 },
            });

            navigateToNode(newNode.id);
          }
          break;

        case 'editChapter':
          if (contextMenu.type === 'node' && contextMenu.nodeId) {
            navigateToNode(contextMenu.nodeId);
          }
          break;

        case 'removeFromStoryline':
          if (contextMenu.type === 'node' && contextMenu.nodeId && contextMenu.storylineId) {
            const nodeStorylines = await getStorylinesByNode(contextMenu.nodeId);

            if (nodeStorylines.length === 1) {
              await deleteNode(contextMenu.nodeId);
              if (currentRouteNodeId === contextMenu.nodeId) {
                navigateToHome();
              }
            } else {
              const nodeInTimeline = nodesWithStorylines.find((n) => n.id === contextMenu.nodeId);
              const currentPrimaryStorylineId =
                nodeInTimeline?.mainStorylineId ?? nodeStorylines[0]?.id;
              const isRemovingPrimaryStoryline =
                currentPrimaryStorylineId === contextMenu.storylineId;

              if (isRemovingPrimaryStoryline) {
                const remainingStorylineIds = nodeStorylines
                  .filter((t) => t.id !== contextMenu.storylineId)
                  .map((t) => t.id);

                await setNodeStorylines(contextMenu.nodeId, remainingStorylineIds);
                if (remainingStorylineIds.length > 0) {
                  await updateNode(contextMenu.nodeId, {
                    mainStorylineId: remainingStorylineIds[0],
                  });
                }
              } else {
                await removeNodeFromStoryline(contextMenu.nodeId, contextMenu.storylineId);
              }
            }

            if (shouldRestoreScroll && scrollContainer) {
              requestAnimationFrame(() => {
                scrollContainer.scrollLeft = savedScrollLeft;
              });
            }
          }
          break;

        case 'deleteNode':
          if (contextMenu.type === 'node' && contextMenu.nodeId) {
            await deleteNode(contextMenu.nodeId);
            if (currentRouteNodeId === contextMenu.nodeId) {
              navigateToHome();
            }

            if (shouldRestoreScroll && scrollContainer) {
              requestAnimationFrame(() => {
                scrollContainer.scrollLeft = savedScrollLeft;
              });
            }
          }
          break;

        case 'addToStoryline':
          if (
            contextMenu.type === 'storyline' &&
            contextMenu.storylineId &&
            contextMenu.canAddCurrentNode &&
            currentRouteNodeId
          ) {
            await addNodeToStoryline(currentRouteNodeId, contextMenu.storylineId);
            if (shouldRestoreScroll && scrollContainer) {
              requestAnimationFrame(() => {
                scrollContainer.scrollLeft = savedScrollLeft;
              });
            }
          } else if (contextMenu.type === 'storyline') {
            onError('No selected node found for addToStoryline action');
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
