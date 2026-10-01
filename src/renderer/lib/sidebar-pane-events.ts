import { events, type AppEvents } from './events';
import type { LeftSidebarTab, SidebarPaneId } from './sidebar-tabs';

export function subscribeSidebarCollapse(
  panel: LeftSidebarTab,
  paneId: SidebarPaneId | null,
  collapse: () => void,
): () => void {
  const handler = (target: AppEvents['left-sidebar:collapse-all']) => {
    if (target.panel === panel && target.paneId === paneId) collapse();
  };
  events.on('left-sidebar:collapse-all', handler);
  return () => events.off('left-sidebar:collapse-all', handler);
}
