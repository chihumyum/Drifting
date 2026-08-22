import { useCallback, useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useParams } from 'react-router-dom';
import { useAuthStore } from '../../store/auth';
import { useUiStore } from '../../store/ui-store';
import { subscribeActiveEditor } from '../../lib/active-editor';
import { useNotificationFeed } from '../../hooks/useNotificationFeed';
import { ProjectRuntimeProvider } from '../../app/providers/ProjectRuntimeProvider';
import { DesktopWorkspace } from './DesktopWorkspace';
import { DesktopOverlayHost } from './DesktopOverlayHost';
import { useDesktopShellEvents } from './useDesktopShellEvents';
import { SuperViewRelationUiProvider } from '../../features/graph/SuperViewRelationUiContext';
import { DesktopWorkspaceNavigationBoundary } from './navigation/DesktopWorkspaceNavigationBoundary';

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
  const closeFindPanel = useCallback(() => setFindPanelEditor(null), []);
  const closeSettings = useCallback(() => {
    setIsSettingsOpen(false);
    setSettingsTargetRail(null);
  }, []);
  const closeImport = useCallback(() => setIsImportOpen(false), []);
  const closeChapterStorylineEditor = useCallback(
    () => setChapterStorylineEditorNodeId(null),
    [setChapterStorylineEditorNodeId],
  );
  const closeGlobalSearch = useCallback(() => setIsGlobalSearchOpen(false), []);

  useDesktopShellEvents({ openSettings, openImport, openSearch: openGlobalSearch });

  useEffect(() => {
    return subscribeActiveEditor((editor) => {
      if (!editor) setFindPanelEditor(null);
    });
  }, []);

  return (
    <ProjectRuntimeProvider projectId={projectId} userId={userId}>
      <SuperViewRelationUiProvider key={projectId} projectId={projectId}>
        <DesktopWorkspaceNavigationBoundary
          projectId={projectId}
          openFind={openFind}
          openGlobalSearch={openGlobalSearch}
        >
          <DesktopWorkspace
            activeLeftPanel={activeLeftPanel}
            bottomTimelineHidden={bottomTimelineHidden}
            findPanelEditor={findPanelEditor}
            onCloseFindPanel={closeFindPanel}
          />
          <DesktopOverlayHost
            activeSuperView={activeSuperView}
            isSettingsOpen={isSettingsOpen}
            settingsTargetRail={settingsTargetRail}
            onCloseSettings={closeSettings}
            isImportOpen={isImportOpen}
            onCloseImport={closeImport}
            chapterStorylineEditorNodeId={chapterStorylineEditorNodeId}
            onCloseChapterStorylineEditor={closeChapterStorylineEditor}
            isGlobalSearchOpen={isGlobalSearchOpen}
            onCloseGlobalSearch={closeGlobalSearch}
          />
        </DesktopWorkspaceNavigationBoundary>
      </SuperViewRelationUiProvider>
    </ProjectRuntimeProvider>
  );
}
