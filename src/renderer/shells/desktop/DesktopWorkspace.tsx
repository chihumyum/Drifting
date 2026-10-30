import type { Editor } from '@tiptap/core';
import { memo, useRef, useState } from 'react';
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
import { useChapterInFront, useUiStore } from '../../store/ui-store';
import { DesktopBottomTimeline } from './views/DesktopBottomTimeline';
import { TimelineDrawer } from './TimelineDrawer';
import { DesktopRightSidebar } from './DesktopRightSidebar';
import { DesktopLeftSidebar } from './DesktopLeftSidebar';
import { useInertUnderSuperView } from './useInertUnderSuperView';

interface DesktopWorkspaceProps {
  projectId: string;
  bottomTimelineHidden: boolean;
  findPanelEditor: Editor | null;
  onCloseFindPanel: () => void;
}

/**
 * Three full-height columns and nothing across them: no title bar, tab strip
 * or status line. The sidebar toggles are fixed in the window's top corners;
 * the desk column keeps a transparent window-drag strip, and under the paper
 * one optional Bottom Panel holding the Bottom Timeline or the focused
 * chapter's plot planner, never both; the planner hides itself while no
 * chapter is in front. The open-document dots run along the paper's top on
 * the traffic-light line; the timeline toggle rests in the paper's
 * lower-right corner to the left of the editor's toolbar (whose first button
 * is the plot planner; the stage keeps a fallback for when no editor is
 * showing), so both ride above the dock when it is open. While a Super View
 * covers the window, all of it is inert.
 */
export const DesktopWorkspace = memo(function DesktopWorkspace({
  projectId,
  bottomTimelineHidden,
  findPanelEditor,
  onCloseFindPanel,
}: DesktopWorkspaceProps) {
  const plotPlannerOpen = useUiStore((state) => state.plotPlannerOpen);
  // The planner belongs to the chapter in front. Elsewhere it hides itself
  // (the panel closes, the timeline stays hidden) and comes back with the
  // next chapter, the choice to show it kept.
  const chapterInFront = useChapterInFront(projectId);
  const dockPane: BottomPanelPane | null = plotPlannerOpen
    ? (chapterInFront ? 'planner' : null)
    : bottomTimelineHidden ? null : 'timeline';
  // While the panel slides shut it keeps showing what it held.
  const [lastPane, setLastPane] = useState<BottomPanelPane>(dockPane ?? 'timeline');
  if (dockPane && dockPane !== lastPane) setLastPane(dockPane);
  const rootRef = useRef<HTMLDivElement>(null);
  useInertUnderSuperView(rootRef);
  return (
    <div ref={rootRef} className="app-root desktop-app-shell">
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
 * own chapter's planner in here. The panel shows it only with a chapter in
 * front, so the bare header that stands in is seen only while that chapter's
 * editor is still opening.
 */
function PlotPlannerSlot() {
  const { t } = useTranslation();
  return (
    <div className="plot-planner-slot" ref={setPlotPlannerSlot}>
      <div className="plot-planner-slot__empty">
        <BottomPanelHeader
          start={<span className="plot-planner__title"><span className="plot-planner__label">{t('plotGrid.title')}</span></span>}
        />
      </div>
    </div>
  );
}
