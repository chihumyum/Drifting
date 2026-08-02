import { useCallback, useReducer } from 'react';
import type { BottomTimelineContextMenuState, TimelineNode } from './types';

export interface BottomTimelineDragOverPosition {
  storylineId: string;
  // Target bookOrder slot the dragged tile would snap into.
  order: number;
  x: number;
}

interface BottomTimelineInteractionState {
  draggedNode: { node: TimelineNode; storylineId: string } | null;
  dragOverPosition: BottomTimelineDragOverPosition | null;
  contextMenu: BottomTimelineContextMenuState | null;
  hoveredNodeId: string | null;
  hoverAnchor: HTMLElement | null;
}

type BottomTimelineInteractionAction =
  | { type: 'setDraggedNode'; payload: { node: TimelineNode; storylineId: string } | null }
  | { type: 'setDragOverPosition'; payload: BottomTimelineDragOverPosition | null }
  | { type: 'clearDragState' }
  | { type: 'setContextMenu'; payload: BottomTimelineContextMenuState | null }
  | { type: 'clearContextMenu' }
  | { type: 'setHoverPreview'; payload: { nodeId: string; anchor: HTMLElement } }
  | { type: 'clearHoverPreview' };

const initialInteractionState: BottomTimelineInteractionState = {
  draggedNode: null,
  dragOverPosition: null,
  contextMenu: null,
  hoveredNodeId: null,
  hoverAnchor: null,
};

function interactionReducer(
  state: BottomTimelineInteractionState,
  action: BottomTimelineInteractionAction,
): BottomTimelineInteractionState {
  switch (action.type) {
    case 'setDraggedNode':
      return { ...state, draggedNode: action.payload };
    case 'setDragOverPosition':
      return { ...state, dragOverPosition: action.payload };
    case 'clearDragState':
      return { ...state, draggedNode: null, dragOverPosition: null };
    case 'setContextMenu':
      return { ...state, contextMenu: action.payload };
    case 'clearContextMenu':
      return { ...state, contextMenu: null };
    case 'setHoverPreview':
      return {
        ...state,
        hoveredNodeId: action.payload.nodeId,
        hoverAnchor: action.payload.anchor,
      };
    case 'clearHoverPreview':
      return {
        ...state,
        hoveredNodeId: null,
        hoverAnchor: null,
      };
    default:
      return state;
  }
}

export function useBottomTimelineInteractionState() {
  const [state, dispatch] = useReducer(interactionReducer, initialInteractionState);

  const setDraggedNode = useCallback(
    (payload: { node: TimelineNode; storylineId: string } | null) => {
      dispatch({ type: 'setDraggedNode', payload });
    },
    [],
  );

  const setDragOverPosition = useCallback((payload: BottomTimelineDragOverPosition | null) => {
    dispatch({ type: 'setDragOverPosition', payload });
  }, []);

  const clearDragState = useCallback(() => {
    dispatch({ type: 'clearDragState' });
  }, []);

  const setContextMenu = useCallback((payload: BottomTimelineContextMenuState | null) => {
    dispatch({ type: 'setContextMenu', payload });
  }, []);

  const clearContextMenu = useCallback(() => {
    dispatch({ type: 'clearContextMenu' });
  }, []);

  const setHoverPreview = useCallback(
    (payload: { nodeId: string; anchor: HTMLElement }) => {
      dispatch({ type: 'setHoverPreview', payload });
    },
    [],
  );

  const clearHoverPreview = useCallback(() => {
    dispatch({ type: 'clearHoverPreview' });
  }, []);

  return {
    ...state,
    setDraggedNode,
    setDragOverPosition,
    clearDragState,
    setContextMenu,
    clearContextMenu,
    setHoverPreview,
    clearHoverPreview,
  };
}
