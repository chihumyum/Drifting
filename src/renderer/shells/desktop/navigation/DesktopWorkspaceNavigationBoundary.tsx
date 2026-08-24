import type { Editor } from '@tiptap/core';
import { useLayoutEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { useSyncSplitFocusedUrl } from '../../../components/editor/useSyncSplitFocusedUrl';
import { WorkspaceNavigationProvider } from '../../../features/workspace/navigation/WorkspaceNavigationContext';
import { useDesktopGlobalShortcuts } from '../useDesktopGlobalShortcuts';
import { useDesktopWorkspaceNavigator } from './useDesktopWorkspaceNavigator';
import { focusedLeafOf, tabKey, useUiStore } from '../../../store/ui-store';
import { workspaceUrlFor } from '../../../features/workspace/navigation/workspace-route';
import { useDesktopTabCloseTransition } from './DesktopTabCloseTransition';
import { DesktopTabCloseContext } from './DesktopTabCloseContext';

interface DesktopWorkspaceNavigationBoundaryProps {
  projectId: string;
  openFind(editor: Editor): void;
  openGlobalSearch(): void;
  children: ReactNode;
}

/**
 * The only desktop shell layer that subscribes to child editor routes. Its
 * WorkspaceNavigator value remains stable across pathname changes, so Router
 * updates can flow to the editor Outlet without invalidating the surrounding
 * workspace context.
 */
export function DesktopWorkspaceNavigationBoundary({
  projectId,
  openFind,
  openGlobalSearch,
  children,
}: DesktopWorkspaceNavigationBoundaryProps) {
  const { navigator, navigate } = useDesktopWorkspaceNavigator(projectId);
  const location = useLocation();
  const closeWorkspaceTab = useDesktopTabCloseTransition({ projectId, navigator, navigate });

  useLayoutEffect(() => {
    const entry = location.state as { projectEntry?: unknown } | null;
    if (entry?.projectEntry !== 'resume-last-content') return;
    const project = useUiStore.getState().tabsByProject[projectId];
    const resume = project?.openTabs.find(
      (tab) => tabKey(tab) === project.lastActiveContentTabKey && tab.kind !== 'create',
    );
    const leaf = resume ? focusedLeafOf(resume) : null;
    const url = leaf ? workspaceUrlFor(projectId, leaf) : null;
    if (resume && leaf && url) {
      useUiStore.getState().setActiveTab(
        projectId,
        resume.kind === 'split' ? { splitId: resume.id } : leaf,
      );
      navigate(url, { replace: true, state: null });
      return;
    }
    useUiStore.getState().setActiveTab(projectId, null);
    navigate(`/project/${projectId}`, { replace: true, state: null });
  }, [location.state, navigate, projectId]);

  useSyncSplitFocusedUrl();
  useDesktopGlobalShortcuts({
    projectId,
    openFind,
    openGlobalSearch,
    navigator,
    navigate,
    closeWorkspaceTab,
  });

  return (
    <WorkspaceNavigationProvider navigator={navigator}>
      <DesktopTabCloseContext.Provider value={closeWorkspaceTab}>
        {children}
      </DesktopTabCloseContext.Provider>
    </WorkspaceNavigationProvider>
  );
}
