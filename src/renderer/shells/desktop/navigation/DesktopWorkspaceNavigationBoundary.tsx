import type { Editor } from '@tiptap/core';
import type { ReactNode } from 'react';

import { useSyncSplitFocusedUrl } from '../../../components/editor/useSyncSplitFocusedUrl';
import { WorkspaceNavigationProvider } from '../../../features/workspace/navigation/WorkspaceNavigationContext';
import { useDesktopGlobalShortcuts } from '../useDesktopGlobalShortcuts';
import { useDesktopWorkspaceNavigator } from './useDesktopWorkspaceNavigator';

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

  useSyncSplitFocusedUrl();
  useDesktopGlobalShortcuts({
    projectId,
    openFind,
    openGlobalSearch,
    navigator,
    navigate,
  });

  return (
    <WorkspaceNavigationProvider navigator={navigator}>
      {children}
    </WorkspaceNavigationProvider>
  );
}
