import type { Editor } from '@tiptap/core';
import { memo } from 'react';
import { Sidebar } from '../../components/Sidebar';
import { EditorMainArea } from '../../components/editor/EditorMainArea';
import { EditorFindPanel } from '../../components/search/EditorFindPanel';
import { WorkspaceCornerControls } from '../../components/workspaceChrome/WorkspaceCornerControls';
import { WorkspaceTabDock } from '../../components/workspaceChrome/WorkspaceTabDock';
import { WorkspaceWordCount } from '../../components/workspaceChrome/WorkspaceWordCount';
import { DesktopBottomTimeline } from './views/DesktopBottomTimeline';
import { DesktopRightSidebar } from './DesktopRightSidebar';
import { DesktopLeftSidebar } from './DesktopLeftSidebar';

interface DesktopWorkspaceProps {
  bottomTimelineHidden: boolean;
  findPanelEditor: Editor | null;
  onCloseFindPanel: () => void;
}

/**
 * Three full-height columns and nothing across them: no title bar, tab strip
 * or status line. The desk column keeps a transparent window-drag strip for
 * the sidebar toggles, and under the paper the optional Bottom Timeline. The
 * open-document dots, the timeline toggle and the word count rest on the
 * paper's lower edge, so they ride above the timeline when it is open.
 */
export const DesktopWorkspace = memo(function DesktopWorkspace({
  bottomTimelineHidden,
  findPanelEditor,
  onCloseFindPanel,
}: DesktopWorkspaceProps) {
  return (
    <div className="app-root desktop-app-shell">
      <div className="app-row desktop-workspace-row">
        <Sidebar sidebarType="left">
          <DesktopLeftSidebar />
        </Sidebar>

        <main className="app-mid desktop-workspace-main">
          <WorkspaceCornerControls />
          <div className="workspace-stage desktop-workspace-stage">
            <EditorMainArea />
            <WorkspaceWordCount />
            <WorkspaceTabDock />
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
    </div>
  );
});
