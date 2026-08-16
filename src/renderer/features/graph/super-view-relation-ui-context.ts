import { createContext, useCallback, useContext, useMemo } from 'react';
import type { EdgeKindMetaApi } from '../../hooks/useEdgeKindMeta';
import type { SuperViewRelationCanvas } from './super-view-relation-menu-model';

export interface CanvasRelationUiState {
  hiddenRelationTypeIds: ReadonlySet<string>;
  driftPanelOpen: boolean;
}

export interface SuperViewRelationUiContextValue {
  edgeKindMeta: EdgeKindMetaApi;
  canvasState: Record<SuperViewRelationCanvas, CanvasRelationUiState>;
  toggleRelationTypeId: (canvas: SuperViewRelationCanvas, relationTypeId: string) => void;
  setDriftPanelOpen: (canvas: SuperViewRelationCanvas, open: boolean) => void;
}

export const SuperViewRelationUiContext = createContext<SuperViewRelationUiContextValue | null>(
  null,
);

export function useSuperViewRelationUi(canvas: SuperViewRelationCanvas) {
  const value = useContext(SuperViewRelationUiContext);
  if (!value) throw new Error('useSuperViewRelationUi requires SuperViewRelationUiProvider');
  const { edgeKindMeta, canvasState, toggleRelationTypeId: toggleCanvasRelationTypeId } = value;
  const setCanvasDriftPanelOpen = value.setDriftPanelOpen;
  const toggleRelationTypeId = useCallback(
    (relationTypeId: string) => toggleCanvasRelationTypeId(canvas, relationTypeId),
    [canvas, toggleCanvasRelationTypeId],
  );
  const setDriftPanelOpen = useCallback(
    (open: boolean) => setCanvasDriftPanelOpen(canvas, open),
    [canvas, setCanvasDriftPanelOpen],
  );
  return useMemo(
    () => ({
      edgeKindMeta,
      hiddenRelationTypeIds: canvasState[canvas].hiddenRelationTypeIds,
      driftPanelOpen: canvasState[canvas].driftPanelOpen,
      toggleRelationTypeId,
      setDriftPanelOpen,
    }),
    [canvas, canvasState, edgeKindMeta, setDriftPanelOpen, toggleRelationTypeId],
  );
}
