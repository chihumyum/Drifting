import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import {
  useLocation,
  useNavigate,
  type NavigateFunction,
  type NavigateOptions,
  type To,
} from 'react-router-dom';

import { workspaceUrlFor } from '../../../features/workspace/navigation/workspace-route';
import type {
  WorkspaceNavigator,
  WorkspaceTarget,
} from '../../../features/workspace/navigation/workspace-target';
import { focusedLeafOf, tabKey, useUiStore } from '../../../store/ui-store';

export interface DesktopWorkspaceNavigation {
  navigator: WorkspaceNavigator;
  navigate: NavigateFunction;
}

type PendingCreateRouteTransition =
  | {
      kind: 'target';
      pathname: string;
      target: WorkspaceTarget;
      preview: boolean;
    }
  | {
      kind: 'home';
      pathname: string;
    };

function activeTabIsCreate(projectId: string): boolean {
  const project = useUiStore.getState().tabsByProject[projectId];
  const active = project?.openTabs.find((tab) => tabKey(tab) === project.activeTabKey);
  return active?.kind === 'create';
}

/**
 * Owns the desktop Router subscription while exposing a navigator whose
 * identity changes only with project identity. Route callbacks read the latest
 * pathname/navigate function through refs, so child editor URL changes do not
 * invalidate the WorkspaceNavigation context consumed by the shell.
 */
export function useDesktopWorkspaceNavigator(projectId: string): DesktopWorkspaceNavigation {
  const location = useLocation();
  const routerNavigate = useNavigate();
  const pathnameRef = useRef(location.pathname);
  const navigateRef = useRef(routerNavigate);
  const pendingCreateTransitionRef = useRef<PendingCreateRouteTransition | null>(null);

  const commitTarget = useCallback(
    (target: WorkspaceTarget, preview: boolean) => {
      const state = useUiStore.getState();
      if (!state.activateExistingTarget(projectId, target)) {
        state.openEntityTab(projectId, target, { preview });
      }
    },
    [projectId],
  );

  const commitHome = useCallback(() => {
    const state = useUiStore.getState();
    state.setActiveTab(projectId, null);
    if (state.nodeUi.selectedId) state.setNodeSelection(null);
    if (state.elementUi.selectedId) state.setElementSelection(null);
    if (state.activeSuperView !== 'none') state.setActiveSuperView('none');
  }, [projectId]);

  useLayoutEffect(() => {
    pathnameRef.current = location.pathname;
    navigateRef.current = routerNavigate;

    const pending = pendingCreateTransitionRef.current;
    if (!pending) return;
    if (pending.pathname !== location.pathname) {
      if (location.pathname !== `/project/${projectId}/new`) {
        pendingCreateTransitionRef.current = null;
      }
      return;
    }
    pendingCreateTransitionRef.current = null;

    if (pending.kind === 'target') {
      commitTarget(pending.target, pending.preview);
      return;
    }

    commitHome();
  }, [commitHome, commitTarget, location.pathname, projectId, routerNavigate]);

  const stableNavigate = useCallback(
    (to: To | number, options?: NavigateOptions) => {
      if (typeof to === 'number') {
        navigateRef.current(to);
        return;
      }
      navigateRef.current(to, options);
    },
    [],
  );
  const navigate = stableNavigate as NavigateFunction;

  const pushTarget = useCallback(
    (target: WorkspaceTarget) => {
      const pathname = workspaceUrlFor(projectId, target);
      if (!pathname || pathname === pathnameRef.current) return;
      navigate(pathname);
    },
    [navigate, projectId],
  );

  const open = useCallback<WorkspaceNavigator['open']>(
    (target, options) => {
      const preview = options?.preview ?? true;
      const pathname = workspaceUrlFor(projectId, target);
      if (
        pathname &&
        pathname !== pathnameRef.current &&
        activeTabIsCreate(projectId)
      ) {
        pendingCreateTransitionRef.current = {
          kind: 'target',
          pathname,
          target,
          preview,
        };
        navigate(pathname);
        return;
      }
      commitTarget(target, preview);
      pushTarget(target);
    },
    [commitTarget, navigate, projectId, pushTarget],
  );

  const activate = useCallback<WorkspaceNavigator['activate']>(
    (target) => {
      const pathname = workspaceUrlFor(projectId, target);
      if (
        pathname &&
        pathname !== pathnameRef.current &&
        activeTabIsCreate(projectId)
      ) {
        pendingCreateTransitionRef.current = {
          kind: 'target',
          pathname,
          target,
          preview: true,
        };
        navigate(pathname);
        return;
      }
      commitTarget(target, true);
      pushTarget(target);
    },
    [commitTarget, navigate, projectId, pushTarget],
  );

  const showProjectHome = useCallback<WorkspaceNavigator['showProjectHome']>(
    (options) => {
      const pathname = `/project/${projectId}`;
      if (activeTabIsCreate(projectId)) {
        if (pathname !== pathnameRef.current) {
          pendingCreateTransitionRef.current = { kind: 'home', pathname };
          navigate(pathname, { replace: options?.replace ?? false });
          return;
        }
        commitHome();
        return;
      }
      const state = useUiStore.getState();
      if (state.nodeUi.selectedId) state.setNodeSelection(null);
      if (state.elementUi.selectedId) state.setElementSelection(null);
      if (state.activeSuperView !== 'none') state.setActiveSuperView('none');
      navigate(pathname, { replace: options?.replace ?? false });
    },
    [commitHome, navigate, projectId],
  );

  const leaveDeletedTarget = useCallback(() => {
    const project = useUiStore.getState().tabsByProject[projectId];
    const active = project?.openTabs.find((tab) => tabKey(tab) === project.activeTabKey);
    const target = active ? focusedLeafOf(active) : null;
    if (target) {
      pushTarget(target);
      return;
    }
    navigate(`/project/${projectId}`, { replace: true });
  }, [navigate, projectId, pushTarget]);

  const navigator = useMemo<WorkspaceNavigator>(
    () => ({ projectId, open, activate, showProjectHome, leaveDeletedTarget }),
    [activate, leaveDeletedTarget, open, projectId, showProjectHome],
  );

  return useMemo(() => ({ navigator, navigate }), [navigate, navigator]);
}
