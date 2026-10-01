import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useUiStore } from '../../store/ui-store';
import { LeftSidebarHeader } from '../../components/leftBars/LeftSidebarHeader';
import { LeftSidebarSubHeader } from '../../components/leftBars/LeftSidebarSubHeader';
import { ElementPanel } from '../../components/leftBars/ElementPanel';
import { DriftPanel } from '../../components/leftBars/DriftPanel';
import { ChapterPanel } from '../../components/leftBars/ChapterPanel';
import { DesktopSidebarLayout } from './DesktopSidebarLayout';

export function DesktopLeftSidebar() {
  const { projectId } = useProjectNavigation();
  const panes = useUiStore((s) => s.desktopSidebarTabs.left.panes);
  return (
    <DesktopSidebarLayout projectId={projectId} side="left" panels={panes.map(({ id, tab }) => ({
      id,
      tab,
      header: <LeftSidebarHeader paneId={id} activeTab={tab} />,
      content: <>
        <LeftSidebarSubHeader panel={tab} />
        <div className="desktop-sidebar-panel-host">
          {tab === 'elements' ? <ElementPanel /> : tab === 'drift' ? <DriftPanel /> : <ChapterPanel />}
        </div>
      </>,
    }))} />
  );
}
