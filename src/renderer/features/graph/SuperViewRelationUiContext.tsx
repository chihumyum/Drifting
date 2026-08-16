import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useEdgeKindMeta } from '../../hooks/useEdgeKindMeta';
import type { SuperViewRelationCanvas } from './super-view-relation-menu-model';
import {
  SuperViewRelationUiContext,
  type CanvasRelationUiState,
} from './super-view-relation-ui-context';

function initialCanvasState(): Record<SuperViewRelationCanvas, CanvasRelationUiState> {
  return {
    element: { hiddenRelationTypeIds: new Set(), driftPanelOpen: false },
    graph: { hiddenRelationTypeIds: new Set(), driftPanelOpen: false },
  };
}

export function SuperViewRelationUiProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const edgeKindMeta = useEdgeKindMeta(projectId);
  const [canvasState, setCanvasState] = useState(initialCanvasState);

  const toggleRelationTypeId = useCallback(
    (canvas: SuperViewRelationCanvas, relationTypeId: string) => {
      setCanvasState((current) => {
        const hiddenRelationTypeIds = new Set(current[canvas].hiddenRelationTypeIds);
        if (hiddenRelationTypeIds.has(relationTypeId)) hiddenRelationTypeIds.delete(relationTypeId);
        else hiddenRelationTypeIds.add(relationTypeId);
        return { ...current, [canvas]: { ...current[canvas], hiddenRelationTypeIds } };
      });
    },
    [],
  );

  const setDriftPanelOpen = useCallback((canvas: SuperViewRelationCanvas, open: boolean) => {
    setCanvasState((current) =>
      current[canvas].driftPanelOpen === open
        ? current
        : { ...current, [canvas]: { ...current[canvas], driftPanelOpen: open } },
    );
  }, []);

  const value = useMemo(
    () => ({ edgeKindMeta, canvasState, toggleRelationTypeId, setDriftPanelOpen }),
    [canvasState, edgeKindMeta, setDriftPanelOpen, toggleRelationTypeId],
  );

  return (
    <SuperViewRelationUiContext.Provider value={value}>
      {children}
    </SuperViewRelationUiContext.Provider>
  );
}
