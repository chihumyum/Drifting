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
  useLayoutEffect(() => {
    pathnameRef.current = location.pathname;
    navigateRef.current = routerNavigate;
  }, [location.pathname, routerNavigate]);

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
      const state = useUiStore.getState();
      if (!state.activateExistingTarget(projectId, target)) {
        state.openEntityTab(projectId, target, { preview: options?.preview ?? true });
      }
      pushTarget(target);
    },
    [projectId, pushTarget],
  );

  const activate = useCallback<WorkspaceNavigator['activate']>(
    (target) => {
      const state = useUiStore.getState();
      if (!state.activateExistingTarget(projectId, target)) {
        state.openEntityTab(projectId, target, { preview: true });
      }
      pushTarget(target);
    },
    [projectId, pushTarget],
  );

  const showProjectHome = useCallback<WorkspaceNavigator['showProjectHome']>(
    (options) => {
      const state = useUiStore.getState();
      if (state.nodeUi.selectedId) state.setNodeSelection(null);
      if (state.elementUi.selectedId) state.setElementSelection(null);
      if (state.activeSuperView !== 'none') state.setActiveSuperView('none');
      navigate(`/project/${projectId}`, { replace: options?.replace ?? false });
    },
    [navigate, projectId],
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
