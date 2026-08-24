import { useCallback, useLayoutEffect, useRef } from 'react';
import { useLocation, type NavigateFunction } from 'react-router-dom';

import { workspaceUrlFor } from '../../../features/workspace/navigation/workspace-route';
import type { WorkspaceNavigator } from '../../../features/workspace/navigation/workspace-target';
import {
  planWorkspaceTabClose,
  tabKey,
  useUiStore,
  type AnyTab,
  type LeafTab,
} from '../../../store/ui-store';

export type CloseDesktopWorkspaceTab = (tab: AnyTab) => void;

interface PendingCreateClose {
  tabKey: string;
  createRoute: string;
}

function closeRefFor(tab: AnyTab) {
  if (tab.kind === 'split') return { splitId: tab.id } as const;
  if (tab.kind === 'create') return { createId: tab.id } as const;
  return { entityType: tab.entityType, id: tab.id } as const;
}

function closeDestination(projectId: string, nextActive: LeafTab | null): string {
  return nextActive
    ? (workspaceUrlFor(projectId, nextActive) ?? `/project/${projectId}`)
    : `/project/${projectId}`;
}

export function useDesktopTabCloseTransition({
  projectId,
  navigator,
  navigate,
}: {
  projectId: string;
  navigator: WorkspaceNavigator;
  navigate: NavigateFunction;
}): CloseDesktopWorkspaceTab {
  const location = useLocation();
  const pendingCreateCloseRef = useRef<PendingCreateClose | null>(null);

  const closeImmediately = useCallback(
    (tab: AnyTab) => {
      const { nextActive, wasActive } = useUiStore
        .getState()
        .closeTab(projectId, closeRefFor(tab));
      if (nextActive) {
        navigator.open(nextActive);
      } else if (wasActive) {
        navigate(`/project/${projectId}`, { replace: true });
      }
    },
    [navigate, navigator, projectId],
  );

  // Keep create ownership until HashRouter completes its transition. The
  // persistent editor stage independently retains the draft pixels until the
  // selected destination reports ready.
  useLayoutEffect(() => {
    const pending = pendingCreateCloseRef.current;
    if (!pending || location.pathname === pending.createRoute) return;

    const state = useUiStore.getState();
    const project = state.tabsByProject[projectId];
    const closing = project?.openTabs.find((tab) => tabKey(tab) === pending.tabKey);
    if (!project || !closing || closing.kind !== 'create') {
      pendingCreateCloseRef.current = null;
      return;
    }

    const plan = planWorkspaceTabClose(project, pending.tabKey);
    if (!plan) {
      pendingCreateCloseRef.current = null;
      return;
    }

    if (plan.wasActive) {
      const destination = closeDestination(projectId, plan.nextActive);
      if (location.pathname !== destination) {
        navigate(destination, { replace: true });
        return;
      }
    }

    pendingCreateCloseRef.current = null;
    state.closeTab(projectId, { createId: closing.id });
  }, [location.pathname, navigate, projectId]);

  return useCallback(
    (requestedTab: AnyTab) => {
      const state = useUiStore.getState();
      const project = state.tabsByProject[projectId];
      const closingKey = tabKey(requestedTab);
      const closing = project?.openTabs.find((tab) => tabKey(tab) === closingKey);
      if (!project || !closing) return;

      const plan = planWorkspaceTabClose(project, closingKey);
      if (!plan) return;

      if (closing.kind === 'create' && plan.wasActive) {
        const destination = closeDestination(projectId, plan.nextActive);
        if (location.pathname === destination) {
          state.closeTab(projectId, { createId: closing.id });
          return;
        }
        pendingCreateCloseRef.current = {
          tabKey: closingKey,
          createRoute: `/project/${projectId}/new`,
        };
        navigate(destination, { replace: true });
        return;
      }

      closeImmediately(closing);
    },
    [closeImmediately, location.pathname, navigate, projectId],
  );
}
