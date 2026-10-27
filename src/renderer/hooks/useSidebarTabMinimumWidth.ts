import { useId, useLayoutEffect, useRef } from 'react';
import { sidebarTabMinimumWidth, type SidebarSide } from '../lib/layout-geometry';
import { useSidebarMetricsStore } from '../store/sidebar-metrics-store';

/** The rendered labels own the minimum, independent of a pane's stretched width.
 * Window controls absorbed into the same row (`data-sidebar-header-chrome`)
 * count too, so the tabs never slide under them. */
export function useSidebarTabMinimumWidth(side: SidebarSide) {
  const ref = useRef<HTMLDivElement>(null);
  const source = useId();
  useLayoutEffect(() => {
    const tray = ref.current;
    const row = tray?.parentElement;
    if (!tray || !row || document.documentElement.dataset.shellMode !== 'desktop') return;
    const labels = () => [...tray.querySelectorAll<HTMLElement>('[data-panel-tab-label]')];
    const chrome = () => [...row.querySelectorAll<HTMLElement>(':scope > [data-sidebar-header-chrome]')];
    const measure = () => {
      const widths = labels().map((label) => label.getBoundingClientRect().width);
      if (!widths.length || widths.some((width) => width <= 0)) return;
      const style = getComputedStyle(row);
      const rowGap = parseFloat(style.columnGap) || 0;
      const chromeWidth = chrome().reduce((sum, node) => sum + node.getBoundingClientRect().width + rowGap, 0);
      const minimum = sidebarTabMinimumWidth(widths, parseFloat(getComputedStyle(tray).columnGap) || 0,
        parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + chromeWidth);
      useSidebarMetricsStore.getState().setMinimumWidth(side, minimum, source);
    };
    const resize = new ResizeObserver(measure);
    const observe = () => {
      resize.disconnect();
      resize.observe(row);
      for (const label of labels()) resize.observe(label);
      for (const node of chrome()) resize.observe(node);
      measure();
    };
    // Tab additions/removals and locale changes use the same measurement path.
    const mutation = new MutationObserver(observe);
    mutation.observe(row, { childList: true, subtree: true, characterData: true });
    observe();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      useSidebarMetricsStore.getState().clearMinimumWidth(side, source);
    };
  }, [side, source]);
  return ref;
}
