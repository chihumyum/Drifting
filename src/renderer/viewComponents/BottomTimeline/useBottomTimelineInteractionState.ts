import { useCallback, useReducer } from 'react';
import type { BottomTimelineContextMenuState, TimelineNode } from './types';

export interface BottomTimelineDragOverPosition {
  storylineId: string;
  start: number;
  x: number;
}

export interface BottomTimelineResizingNode {
  nodeId: string;
  storylineId: string;
  edge: 'left' | 'right';
  startX: number;
  startStart: number;
  startEnd: number | null;
}

interface BottomTimelineInteractionState {
  draggedNode: { node: TimelineNode; storylineId: string } | null;
  dragOverPosition: BottomTimelineDragOverPosition | null;
  contextMenu: BottomTimelineContextMenuState | null;
  hoveredEdge: { nodeId: string; edge: 'left' | 'right' } | null;
  hoveredNodeId: string | null;
  hoverPosition: { x: number; y: number } | null;
  resizingNode: BottomTimelineResizingNode | null;
}

type BottomTimelineInteractionAction =
  | { type: 'setDraggedNode'; payload: { node: TimelineNode; storylineId: string } | null }
  | { type: 'setDragOverPosition'; payload: BottomTimelineDragOverPosition | null }
  | { type: 'clearDragState' }
  | { type: 'setContextMenu'; payload: BottomTimelineContextMenuState | null }
  | { type: 'clearContextMenu' }
  | { type: 'setHoveredEdge'; payload: { nodeId: string; edge: 'left' | 'right' } | null }
  | { type: 'setHoverPreview'; payload: { nodeId: string; position: { x: number; y: number } } }
  | { type: 'clearHoverPreview' }
  | { type: 'setResizingNode'; payload: BottomTimelineResizingNode | null }
  | { type: 'clearResizingNode' };

const initialInteractionState: BottomTimelineInteractionState = {
  draggedNode: null,
  dragOverPosition: null,
  contextMenu: null,
  hoveredEdge: null,
  hoveredNodeId: null,
  hoverPosition: null,
  resizingNode: null,
};

function interactionReducer(
  state: BottomTimelineInteractionState,
  action: BottomTimelineInteractionAction
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
    case 'setHoveredEdge':
      return { ...state, hoveredEdge: action.payload };
    case 'setHoverPreview':
      return {
        ...state,
        hoveredNodeId: action.payload.nodeId,
        hoverPosition: action.payload.position,
      };
    case 'clearHoverPreview':
      return {
        ...state,
        hoveredNodeId: null,
        hoverPosition: null,
      };
    case 'setResizingNode':
      return { ...state, resizingNode: action.payload };
    case 'clearResizingNode':
      return { ...state, resizingNode: null };
    default:
      return state;
  }
}

export function useBottomTimelineInteractionState() {
  const [state, dispatch] = useReducer(interactionReducer, initialInteractionState);

  const setDraggedNode = useCallback((payload: { node: TimelineNode; storylineId: string } | null) => {
    dispatch({ type: 'setDraggedNode', payload });
  }, []);

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

  const setHoveredEdge = useCallback((payload: { nodeId: string; edge: 'left' | 'right' } | null) => {
    dispatch({ type: 'setHoveredEdge', payload });
  }, []);

  const setHoverPreview = useCallback((payload: { nodeId: string; position: { x: number; y: number } }) => {
    dispatch({ type: 'setHoverPreview', payload });
  }, []);

  const clearHoverPreview = useCallback(() => {
    dispatch({ type: 'clearHoverPreview' });
  }, []);

  const setResizingNode = useCallback((payload: BottomTimelineResizingNode | null) => {
    dispatch({ type: 'setResizingNode', payload });
  }, []);

  const clearResizingNode = useCallback(() => {
    dispatch({ type: 'clearResizingNode' });
  }, []);

  return {
    ...state,
    setDraggedNode,
    setDragOverPosition,
    clearDragState,
    setContextMenu,
    clearContextMenu,
    setHoveredEdge,
    setHoverPreview,
    clearHoverPreview,
    setResizingNode,
    clearResizingNode,
  };
}
