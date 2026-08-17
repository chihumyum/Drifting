import { useCallback, useReducer } from 'react';
import type { BottomTimelineContextMenuState } from './types';

interface BottomTimelineInteractionState {
  contextMenu: BottomTimelineContextMenuState | null;
  hoveredNodeId: string | null;
  hoverAnchor: HTMLElement | null;
}

type BottomTimelineInteractionAction =
  | { type: 'setContextMenu'; payload: BottomTimelineContextMenuState | null }
  | { type: 'clearContextMenu' }
  | { type: 'setHoverPreview'; payload: { nodeId: string; anchor: HTMLElement } }
  | { type: 'clearHoverPreview' };

const initialInteractionState: BottomTimelineInteractionState = {
  contextMenu: null,
  hoveredNodeId: null,
  hoverAnchor: null,
};

function interactionReducer(
  state: BottomTimelineInteractionState,
  action: BottomTimelineInteractionAction,
): BottomTimelineInteractionState {
  switch (action.type) {
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
    setContextMenu,
    clearContextMenu,
    setHoverPreview,
    clearHoverPreview,
  };
}
