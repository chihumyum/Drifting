import { useMemo } from 'react';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import type { WorkspaceNavigator } from '../../../features/workspace/navigation/workspace-target';

export function useDesktopWorkspaceNavigator(): WorkspaceNavigator {
  const { projectId, openEntity, activateLeafTab, leaveDeletedEntity } = useProjectNavigation();

  return useMemo(
    () => ({
      projectId,
      open: openEntity,
      activate: activateLeafTab,
      leaveDeletedTarget: leaveDeletedEntity,
    }),
    [activateLeafTab, leaveDeletedEntity, openEntity, projectId],
  );
}
