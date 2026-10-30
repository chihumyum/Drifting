import { useCallback } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import type { WorkspaceNavigator } from '../../../features/workspace/navigation/workspace-target';
import { tabKey, useUiStore, type AnyTab } from '../../../store/ui-store';

export type CloseDesktopWorkspaceTab = (tab: AnyTab) => void;

function closeRefFor(tab: AnyTab) {
  if (tab.kind === 'split') return { splitId: tab.id } as const;
  return { entityType: tab.entityType, id: tab.id } as const;
}

/**
 * Closes a top-level tab and lands on its successor, or on Project Home when
 * the closed tab was the active one and nothing else is open.
 */
export function useDesktopTabCloseTransition({
  projectId,
  navigator,
  navigate,
}: {
  projectId: string;
  navigator: WorkspaceNavigator;
  navigate: NavigateFunction;
}): CloseDesktopWorkspaceTab {
  return useCallback(
    (requestedTab: AnyTab) => {
      const state = useUiStore.getState();
      const project = state.tabsByProject[projectId];
      const closing = project?.openTabs.find((tab) => tabKey(tab) === tabKey(requestedTab));
      if (!project || !closing) return;
      const { nextActive, wasActive } = state.closeTab(projectId, closeRefFor(closing));
      if (nextActive) {
        navigator.open(nextActive);
      } else if (wasActive) {
        navigate(`/project/${projectId}`, { replace: true });
      }
    },
    [navigate, navigator, projectId],
  );
}
