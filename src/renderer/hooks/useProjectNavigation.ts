import { useCallback } from 'react';

import { useWorkspaceNavigator } from '../features/workspace/navigation/WorkspaceNavigationContext';
import { SINGLETON_TAB_ID } from '../store/ui-store';

/**
 * Compatibility facade for renderer components that still use the historical
 * typed navigation helpers. Router state belongs to the active shell adapter;
 * consumers subscribe only to the stable WorkspaceNavigator context.
 */
export function useProjectNavigation() {
  const navigator = useWorkspaceNavigator();
  const { projectId } = navigator;

  const openEntity = navigator.open;
  const activateLeafTab = navigator.activate;
  const leaveDeletedEntity = navigator.leaveDeletedTarget;

  const navigateToNode = useCallback(
    (nodeId: string) => openEntity({ entityType: 'node', id: nodeId }),
    [openEntity],
  );
  const navigateToStoryline = useCallback(
    (storylineId: string) => openEntity({ entityType: 'storyline', id: storylineId }),
    [openEntity],
  );
  const navigateToElement = useCallback(
    (elementId: string) => openEntity({ entityType: 'element', id: elementId }),
    [openEntity],
  );
  const navigateToCategory = useCallback(
    (categoryId: string) => openEntity({ entityType: 'category', id: categoryId }),
    [openEntity],
  );
  const navigateToHome = useCallback(
    () => navigator.showProjectHome(),
    [navigator],
  );
  const navigateToAllChapters = useCallback(
    () => openEntity({ entityType: 'all-chapters', id: SINGLETON_TAB_ID }),
    [openEntity],
  );

  return {
    projectId,
    navigateToNode,
    navigateToStoryline,
    navigateToElement,
    navigateToCategory,
    navigateToHome,
    navigateToAllChapters,
    leaveDeletedEntity,
    openEntity,
    activateLeafTab,
  };
}
