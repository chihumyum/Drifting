import { useSidebarPaneId } from '../lib/sidebar-pane-context';
import { useUiStore } from '../store/ui-store';

/** Match the shared layout's one-pixel divider and relative column widths. */
export function useLeftSidebarPanelWidth(): number {
  const paneId = useSidebarPaneId();
  return useUiStore((state) => {
    const { panes } = state.desktopSidebarTabs.left;
    const width = state.sidebars.left.width;
    if (panes.length < 2 || paneId === null) return width;
    const ratio = panes[0].id === paneId ? state.leftPanelSplitRatio : 1 - state.leftPanelSplitRatio;
    return Math.max(0, width - 1) * ratio;
  });
}
