import { useSidebarPaneId } from '../lib/sidebar-pane-context';
import { useUiStore } from '../store/ui-store';
import { clampSidebarSplitRatio, SIDEBAR_DIVIDER_WIDTH } from '../lib/layout-geometry';
import { useSidebarMetricsStore } from '../store/sidebar-metrics-store';

/** Match the shared layout's one-pixel divider and relative column widths. */
export function useLeftSidebarPanelWidth(): number {
  const paneId = useSidebarPaneId();
  const minimumWidth = useSidebarMetricsStore((state) => state.minimumWidths.left);
  return useUiStore((state) => {
    const { panes } = state.desktopSidebarTabs.left;
    const width = state.sidebars.left.width;
    if (panes.length < 2 || paneId === null) return width;
    const splitRatio = clampSidebarSplitRatio(state.leftPanelSplitRatio, minimumWidth, width);
    const ratio = panes[0].id === paneId ? splitRatio : 1 - splitRatio;
    return Math.max(0, width - SIDEBAR_DIVIDER_WIDTH) * ratio;
  });
}
