import type { Editor } from '@tiptap/core';
import { memo } from 'react';
import { AppTopbar } from '../../views/AppTopbar';
import { Sidebar } from '../../components/Sidebar';
import { LeftSidebarHeader } from '../../components/leftBars/LeftSidebarHeader';
import { LeftSidebarSubHeader } from '../../components/leftBars/LeftSidebarSubHeader';
import { ElementPanel } from '../../components/leftBars/ElementPanel';
import { DriftPanel } from '../../components/leftBars/DriftPanel';
import { ChapterPanel } from '../../components/leftBars/ChapterPanel';
import { EditorMainArea } from '../../components/editor/EditorMainArea';
import { EditorFindPanel } from '../../components/search/EditorFindPanel';
import { DesktopBottomTimeline } from './views/DesktopBottomTimeline';
import { DesktopRightSidebar } from './DesktopRightSidebar';
import { BottomStatusBar } from '../../components/BottomStatusBar';

interface DesktopWorkspaceProps {
  activeLeftPanel: 'nodes' | 'elements' | 'drift';
  bottomTimelineHidden: boolean;
  findPanelEditor: Editor | null;
  onCloseFindPanel: () => void;
}

export const DesktopWorkspace = memo(function DesktopWorkspace({
  activeLeftPanel,
  bottomTimelineHidden,
  findPanelEditor,
  onCloseFindPanel,
}: DesktopWorkspaceProps) {
  return (
    <div className="app-root desktop-app-shell">
      <AppTopbar />
      <div className="app-row desktop-workspace-row">
        <Sidebar sidebarType="left">
          <div style={{ flexShrink: 0 }}>
            <LeftSidebarHeader />
          </div>
          <div style={{ flexShrink: 0 }}>
            <LeftSidebarSubHeader />
          </div>
          <div className="desktop-sidebar-panel-host">
            {activeLeftPanel === 'elements' ? (
              <ElementPanel />
            ) : activeLeftPanel === 'drift' ? (
              <DriftPanel />
            ) : (
              <ChapterPanel />
            )}
          </div>
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
