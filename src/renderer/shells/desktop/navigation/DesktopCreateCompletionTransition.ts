import { useCallback, useLayoutEffect, useRef } from 'react';
import { useLocation, type NavigateFunction } from 'react-router-dom';

import { workspaceUrlFor } from '../../../features/workspace/navigation/workspace-route';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { focusedLeafOf, tabKey, useUiStore } from '../../../store/ui-store';

export type CompleteDesktopCreateTab = (target: WorkspaceTarget) => void;

interface PendingCreateCompletion {
  target: WorkspaceTarget;
  pathname: string;
}

function currentDestination(projectId: string): string {
  const project = useUiStore.getState().tabsByProject[projectId];
  const active = project?.openTabs.find((tab) => tabKey(tab) === project.activeTabKey);
  const focused = active ? focusedLeafOf(active) : null;
  return focused
    ? (workspaceUrlFor(projectId, focused) ?? `/project/${projectId}`)
    : `/project/${projectId}`;
}

/**
 * Keeps a successful create draft mounted until its entity route is matched.
 * The in-place tab replacement then runs from a layout effect. The persistent
 * editor stage keeps the draft pixels until the replacement editor reports
 * canonical readiness, so the empty /new child route is never presented.
 */
export function useDesktopCreateCompletionTransition({
  projectId,
  navigate,
}: {
  projectId: string;
  navigate: NavigateFunction;
}): CompleteDesktopCreateTab {
  const location = useLocation();
  const pendingRef = useRef<PendingCreateCompletion | null>(null);
  const activeTabKey = useUiStore(
    (state) => state.tabsByProject[projectId]?.activeTabKey ?? null,
  );

  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;

    const state = useUiStore.getState();
    const project = state.tabsByProject[projectId];
    const createTab = project?.openTabs.find((tab) => tab.kind === 'create');
    if (!project || !createTab) {
      pendingRef.current = null;
      return;
    }

    const createIsActive = project.activeTabKey === tabKey(createTab);
    if (!createIsActive) {
      // Creation resolved while the author moved elsewhere. Restore that
      // destination before replacing the background draft so completion can
      // neither steal focus nor expose the just-created route for one frame.
      const destination = currentDestination(projectId);
      if (location.pathname !== destination) {
        navigate(destination, { replace: true });
        return;
      }
      pendingRef.current = null;
      state.replaceCreateTabWithEntity(projectId, pending.target);
      return;
    }

    if (location.pathname !== pending.pathname) return;
    pendingRef.current = null;
    state.replaceCreateTabWithEntity(projectId, pending.target);
  }, [activeTabKey, location.pathname, navigate, projectId]);

  return useCallback(
    (target: WorkspaceTarget) => {
      const state = useUiStore.getState();
      const project = state.tabsByProject[projectId];
      const createTab = project?.openTabs.find((tab) => tab.kind === 'create');
      if (!project || !createTab) return;

      const createIsActive = project.activeTabKey === tabKey(createTab);
      if (!createIsActive) {
        state.replaceCreateTabWithEntity(projectId, target);
        return;
      }

      const pathname = workspaceUrlFor(projectId, target);
      if (!pathname || pathname === location.pathname) {
        state.replaceCreateTabWithEntity(projectId, target);
        return;
      }

      pendingRef.current = { target, pathname };
      navigate(pathname);
    },
    [location.pathname, navigate, projectId],
  );
}
