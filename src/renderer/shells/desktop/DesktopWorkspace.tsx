import type { Editor } from '@tiptap/core';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sidebar } from '../../components/Sidebar';
import { EditorMainArea } from '../../components/editor/EditorMainArea';
import { EditorFindPanel } from '../../components/search/EditorFindPanel';
import { WorkspaceCornerControls } from '../../components/workspaceChrome/WorkspaceCornerControls';
import { WorkspaceSidebarToggles } from '../../components/workspaceChrome/WindowControlButtons';
import { StageTimelineToggle, WorkspaceTabDock } from '../../components/workspaceChrome/WorkspaceTabDock';
import { BottomPanel, BottomPanelHeader } from '../../components/workspaceChrome/BottomPanel';
import type { BottomPanelPane } from '../../components/workspaceChrome/bottom-panel-context';
import { setPlotPlannerSlot } from '../../components/editor/plot-grid/plot-planner-slot';
import { useUiStore } from '../../store/ui-store';
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
 * one optional Bottom Panel holding the Bottom Timeline or the focused
 * chapter's plot planner, never both. The open-document dots run along the paper's top on
 * the traffic-light line; the timeline toggle rests in the paper's
 * lower-right corner to the left of the editor's toolbar (whose first button
 * is the plot planner; the stage keeps a fallback for when no editor is
 * showing), so both ride above the dock when it is open.
 */
export const DesktopWorkspace = memo(function DesktopWorkspace({
  bottomTimelineHidden,
  findPanelEditor,
  onCloseFindPanel,
}: DesktopWorkspaceProps) {
  const plotPlannerOpen = useUiStore((state) => state.plotPlannerOpen);
  const dockPane: BottomPanelPane | null = plotPlannerOpen ? 'planner' : bottomTimelineHidden ? null : 'timeline';
  // While the panel slides shut it keeps showing what it held.
  const [lastPane, setLastPane] = useState<BottomPanelPane>(dockPane ?? 'timeline');
  if (dockPane && dockPane !== lastPane) setLastPane(dockPane);
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
            <StageTimelineToggle />
          </div>
          <TimelineDrawer open={dockPane !== null}>
            <BottomPanel show={dockPane ?? lastPane}>
              {{ timeline: <DesktopBottomTimeline />, planner: <PlotPlannerSlot /> }}
            </BottomPanel>
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

/**
 * The Bottom Panel's plot-planner place. The focused node editor portals its
 * own chapter's planner in here; with no chapter in front, the panel's header
 * names the planner and a quiet line says why it is empty.
 */
function PlotPlannerSlot() {
  const { t } = useTranslation();
  return (
    <div className="plot-planner-slot" ref={setPlotPlannerSlot}>
      <div className="plot-planner-slot__empty">
        <BottomPanelHeader
          start={<span className="plot-planner__title"><span className="plot-planner__label">{t('plotGrid.title')}</span></span>}
        />
        <p className="plot-planner-slot__note">{t('plotGrid.noChapter')}</p>
      </div>
    </div>
  );
}
