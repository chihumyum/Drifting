import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { SidebarEditorSelectionContext } from '../../hooks/useSidebarPanelState';
import { useUiStore, useProjectTabs, tabKey } from '../../store/ui-store';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { isDrift } from '../../domain/book-node';
import type { LeftSidebarTab } from '../../lib/sidebar-tabs';
import { LeftSidebarHeader } from '../../components/leftBars/LeftSidebarHeader';
import { LeftSidebarSubHeader } from '../../components/leftBars/LeftSidebarSubHeader';
import { ElementPanel } from '../../components/leftBars/ElementPanel';
import { DriftPanel } from '../../components/leftBars/DriftPanel';
import { ChapterPanel } from '../../components/leftBars/ChapterPanel';
import { DesktopSidebarLayout } from './DesktopSidebarLayout';

export function DesktopLeftSidebar() {
  const { projectId } = useProjectNavigation();
  const { panes, focusedPane } = useUiStore((s) => s.desktopSidebarTabs.left);
  const { activeTabKey, openTabs } = useProjectTabs(projectId);
  const { bookNodes } = useDataStoreFields('bookNodes');
  const activeTab = openTabs.find(tab => tabKey(tab) === activeTabKey);
  const singleTarget = activeTab?.kind === 'leaf' ? activeTab : null;
  let targetTab: LeftSidebarTab | null = null;
  if (singleTarget?.entityType === 'element') targetTab = 'elements';
  if (singleTarget?.entityType === 'node') {
    const node = bookNodes.find(node => node.id === singleTarget.id);
    if (node) targetTab = isDrift(node) ? 'drift' : 'nodes';
  }
  // A single visible editor owns one highlight, even with duplicate sidebar
  // tabs. Historical pane selections remain available for split editors.
  const selectedPane = panes.find(pane => pane.tab === targetTab && pane.id === focusedPane)
    ?? panes.find(pane => pane.tab === targetTab);
  return (
    <DesktopSidebarLayout projectId={projectId} side="left" panels={panes.map(({ id, tab }) => ({
      id,
      tab,
      header: <LeftSidebarHeader paneId={id} activeTab={tab} />,
      content: <SidebarEditorSelectionContext.Provider value={activeTab?.kind === 'split'
        ? undefined : selectedPane?.id === id ? singleTarget : null}>
        <LeftSidebarSubHeader panel={tab} />
        <div className="desktop-sidebar-panel-host">
          {tab === 'elements' ? <ElementPanel /> : tab === 'drift' ? <DriftPanel /> : <ChapterPanel />}
        </div>
      </SidebarEditorSelectionContext.Provider>,
    }))} />
  );
}
