import type { Editor } from '@tiptap/core';
import { memo } from 'react';
import { Sidebar } from '../../components/Sidebar';
import { EditorMainArea } from '../../components/editor/EditorMainArea';
import { EditorFindPanel } from '../../components/search/EditorFindPanel';
import { WorkspaceCornerControls } from '../../components/workspaceChrome/WorkspaceCornerControls';
import { WorkspaceSidebarToggles } from '../../components/workspaceChrome/WindowControlButtons';
import { TimelineToggle, WorkspaceTabDock } from '../../components/workspaceChrome/WorkspaceTabDock';
import { DesktopBottomTimeline } from './views/DesktopBottomTimeline';
import { TimelineDrawer } from './TimelineDrawer';
import { DesktopRightSidebar } from './DesktopRightSidebar';
import { DesktopLeftSidebar } from './DesktopLeftSidebar';

interface DesktopWorkspaceProps {
  bottomTimelineHidden: boolean;
  findPanelEditor: Editor | null;
  onCloseFindPanel: () => void;
}

/**
 * Three full-height columns and nothing across them: no title bar, tab strip
 * or status line. The sidebar toggles are fixed in the window's top corners;
 * the desk column keeps a transparent window-drag strip, and under the paper
 * the optional Bottom Timeline. The open-document dots run along the paper's
 * top on the traffic-light line; the timeline toggle rests in the paper's
 * lower-right corner beside the editor's toolbar, so it rides above the
 * timeline when it is open.
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
            <WorkspaceTabDock />
            <TimelineToggle />
          </div>
          <TimelineDrawer open={!bottomTimelineHidden}>
            <DesktopBottomTimeline />
          </TimelineDrawer>
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
      <WorkspaceSidebarToggles />
    </div>
  );
});
