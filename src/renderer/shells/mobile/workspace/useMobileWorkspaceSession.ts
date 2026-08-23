import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type {
  WorkspaceNavigator,
  WorkspaceTarget,
} from '../../../features/workspace/navigation/workspace-target';
import {
  workspaceTargetFromPathname,
  workspaceUrlFor,
} from '../../../features/workspace/navigation/workspace-route';
import {
  mobilePaperKey,
  mobileWorkspaceSessionReducer,
} from './mobile-workspace-session';
import {
  readMobileWorkspaceSession,
  writeMobileWorkspaceSession,
} from './mobile-workspace-session-storage';

function readInitial(projectId: string) {
  return readMobileWorkspaceSession(
    typeof localStorage === 'undefined' ? null : localStorage,
    projectId,
  );
}

export function useMobileWorkspaceSession(projectId: string) {
  const navigate = useNavigate();
  const location = useLocation();
  const [state, dispatch] = useReducer(mobileWorkspaceSessionReducer, projectId, readInitial);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    writeMobileWorkspaceSession(
      typeof localStorage === 'undefined' ? null : localStorage,
      projectId,
      state,
    );
  }, [projectId, state]);

  const goTo = useCallback(
    (target: WorkspaceTarget, replace = false) => {
      const url = workspaceUrlFor(projectId, target);
      if (url && url !== location.pathname) navigate(url, { replace });
    },
    [location.pathname, navigate, projectId],
  );

  const open = useCallback(
    (target: WorkspaceTarget) => {
      dispatch({ type: 'open', target });
      goTo(target);
    },
    [goTo],
  );

  const activate = useCallback(
    (target: WorkspaceTarget) => {
      dispatch({ type: 'activate', target });
      goTo(target);
    },
    [goTo],
  );

  const close = useCallback(
    (key: string) => {
      const next = mobileWorkspaceSessionReducer(stateRef.current, { type: 'close', key });
      dispatch({ type: 'close', key });
      const active = next.papers.find((paper) => paper.key === next.activeKey);
      if (active) goTo(active.target, true);
      else navigate(`/project/${projectId}`, { replace: true });
    },
    [goTo, navigate, projectId],
  );

  const leaveDeletedTarget = useCallback(() => {
    const current = stateRef.current.activeKey;
    if (current) close(current);
  }, [close]);

  const clear = useCallback(() => {
    dispatch({ type: 'clear' });
    navigate(`/project/${projectId}`, { replace: true });
  }, [navigate, projectId]);

  const rememberScroll = useCallback((key: string, scrollTop: number) => {
    dispatch({ type: 'remember-scroll', key, scrollTop });
  }, []);

  const navigator = useMemo<WorkspaceNavigator>(
    () => ({
      projectId,
      open,
      activate,
      leaveDeletedTarget,
    }),
    [activate, leaveDeletedTarget, open, projectId],
  );

  useEffect(() => {
    const target = workspaceTargetFromPathname(projectId, location.pathname);
    if (!target) return;
    const key = mobilePaperKey(target);
    if (stateRef.current.activeKey === key) return;
    dispatch({ type: 'activate', target });
  }, [location.pathname, projectId]);

  return {
    state,
    navigator,
    open,
    activate,
    close,
    clear,
    reorder: (from: number, to: number) => dispatch({ type: 'reorder', from, to }),
    rememberScroll,
  };
}
