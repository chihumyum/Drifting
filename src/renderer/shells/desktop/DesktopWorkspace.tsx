import type { Editor } from '@tiptap/core';
import { memo } from 'react';
import { AppTopbar } from '../../views/AppTopbar';
import { Sidebar } from '../../components/Sidebar';
import { EditorMainArea } from '../../components/editor/EditorMainArea';
import { EditorFindPanel } from '../../components/search/EditorFindPanel';
import { DesktopBottomTimeline } from './views/DesktopBottomTimeline';
import { DesktopRightSidebar } from './DesktopRightSidebar';
import { DesktopLeftSidebar } from './DesktopLeftSidebar';
import { BottomStatusBar } from '../../components/BottomStatusBar';

interface DesktopWorkspaceProps {
  bottomTimelineHidden: boolean;
  findPanelEditor: Editor | null;
  onCloseFindPanel: () => void;
}

export const DesktopWorkspace = memo(function DesktopWorkspace({
  bottomTimelineHidden,
  findPanelEditor,
  onCloseFindPanel,
}: DesktopWorkspaceProps) {
  return (
    <div className="app-root desktop-app-shell">
      <AppTopbar />
      <div className="app-row desktop-workspace-row">
        <Sidebar sidebarType="left">
          <DesktopLeftSidebar />
        </Sidebar>

        <main className="app-mid desktop-workspace-main">
          <div className="workspace-stage desktop-workspace-stage">
            <EditorMainArea />
          </div>
          {!bottomTimelineHidden && (
            <div className="workspace-dock desktop-workspace-dock">
              <DesktopBottomTimeline />
            </div>
          )}
          {findPanelEditor && (
            <EditorFindPanel editor={findPanelEditor} onClose={onCloseFindPanel} />
          )}
        </main>

        <Sidebar sidebarType="right">
          <div className="desktop-sidebar-panel-host">
            <DesktopRightSidebar />
          </div>
        </Sidebar>
      </div>
      <BottomStatusBar />
    </div>
  );
});
