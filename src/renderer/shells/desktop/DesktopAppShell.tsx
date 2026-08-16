import { useCallback, useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useParams } from 'react-router-dom';
import { useAuthStore } from '../../store/auth';
import { useUiStore } from '../../store/ui-store';
import { subscribeActiveEditor } from '../../lib/active-editor';
import { useSyncSplitFocusedUrl } from '../../components/editor/useSyncSplitFocusedUrl';
import { useNotificationFeed } from '../../hooks/useNotificationFeed';
import { ProjectRuntimeProvider } from '../../app/providers/ProjectRuntimeProvider';
import { DesktopWorkspace } from './DesktopWorkspace';
import { DesktopOverlayHost } from './DesktopOverlayHost';
import { useDesktopShellEvents } from './useDesktopShellEvents';
import { useDesktopGlobalShortcuts } from './useDesktopGlobalShortcuts';
import { useDesktopWorkspaceNavigator } from './navigation/useDesktopWorkspaceNavigator';
import { WorkspaceNavigationProvider } from '../../features/workspace/navigation/WorkspaceNavigationContext';
import { SuperViewRelationUiProvider } from '../../features/graph/SuperViewRelationUiContext';

export function DesktopAppShell() {
  const { projectId } = useParams<{ projectId: string }>();
  const userId = useAuthStore((state) => state.user?.id);
  if (!projectId) throw new Error('Project ID is required in URL');
  if (!userId) throw new Error('User must be authenticated');

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTargetRail, setSettingsTargetRail] = useState<string | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [findPanelEditor, setFindPanelEditor] = useState<Editor | null>(null);
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const activeSuperView = useUiStore((state) => state.activeSuperView);
  const activeLeftPanel = useUiStore((state) => state.activeLeftPanel);
  const bottomTimelineHidden = useUiStore((state) => state.bottomTimelineHidden);
  const chapterStorylineEditorNodeId = useUiStore((state) => state.chapterStorylineEditorNodeId);
  const setChapterStorylineEditorNodeId = useUiStore(
    (state) => state.setChapterStorylineEditorNodeId,
  );
  const workspaceNavigator = useDesktopWorkspaceNavigator();

  useSyncSplitFocusedUrl();
  useNotificationFeed();

  const openSettings = useCallback((railId: string | null) => {
    setSettingsTargetRail(railId);
    setIsSettingsOpen(true);
  }, []);
  const openImport = useCallback(() => setIsImportOpen(true), []);
  const openGlobalSearch = useCallback(() => {
    setFindPanelEditor(null);
    setIsGlobalSearchOpen(true);
  }, []);
  const openFind = useCallback((editor: Editor) => setFindPanelEditor(editor), []);

  useDesktopShellEvents({ openSettings, openImport, openSearch: openGlobalSearch });
  useDesktopGlobalShortcuts({ projectId, openFind, openGlobalSearch });

  useEffect(() => {
    return subscribeActiveEditor((editor) => {
      if (!editor) setFindPanelEditor(null);
    });
  }, []);

  return (
    <ProjectRuntimeProvider projectId={projectId} userId={userId}>
      <SuperViewRelationUiProvider key={projectId} projectId={projectId}>
        <WorkspaceNavigationProvider navigator={workspaceNavigator}>
          <DesktopWorkspace
            activeLeftPanel={activeLeftPanel}
            bottomTimelineHidden={bottomTimelineHidden}
            findPanelEditor={findPanelEditor}
            onCloseFindPanel={() => setFindPanelEditor(null)}
          />
          <DesktopOverlayHost
            activeSuperView={activeSuperView}
            isSettingsOpen={isSettingsOpen}
            settingsTargetRail={settingsTargetRail}
            onCloseSettings={() => {
              setIsSettingsOpen(false);
              setSettingsTargetRail(null);
            }}
            isImportOpen={isImportOpen}
            onCloseImport={() => setIsImportOpen(false)}
            chapterStorylineEditorNodeId={chapterStorylineEditorNodeId}
            onCloseChapterStorylineEditor={() => setChapterStorylineEditorNodeId(null)}
            isGlobalSearchOpen={isGlobalSearchOpen}
            onCloseGlobalSearch={() => setIsGlobalSearchOpen(false)}
          />
        </WorkspaceNavigationProvider>
      </SuperViewRelationUiProvider>
    </ProjectRuntimeProvider>
  );
}
