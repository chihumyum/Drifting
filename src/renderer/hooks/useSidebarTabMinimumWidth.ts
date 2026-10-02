import { useLayoutEffect, useRef } from 'react';
import { sidebarTabMinimumWidth, type SidebarSide } from '../lib/layout-geometry';
import { useSidebarMetricsStore } from '../store/sidebar-metrics-store';

/** The rendered labels own the minimum, independent of a pane's stretched width. */
export function useSidebarTabMinimumWidth(side: SidebarSide) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tray = ref.current;
    const row = tray?.parentElement;
    if (!tray || !row || document.documentElement.dataset.shellMode !== 'desktop') return;
    const labels = () => [...tray.querySelectorAll<HTMLElement>('[data-panel-tab-label]')];
    const measure = () => {
      const widths = labels().map((label) => label.getBoundingClientRect().width);
      if (!widths.length || widths.some((width) => width <= 0)) return;
      const style = getComputedStyle(row);
      const minimum = sidebarTabMinimumWidth(widths, parseFloat(getComputedStyle(tray).columnGap) || 0,
        parseFloat(style.paddingLeft) + parseFloat(style.paddingRight));
      useSidebarMetricsStore.getState().setMinimumWidth(side, minimum);
    };
    const resize = new ResizeObserver(measure);
    const observe = () => {
      resize.disconnect();
      resize.observe(row);
      for (const label of labels()) resize.observe(label);
      measure();
    };
    // Tab additions/removals and locale changes use the same measurement path.
    const mutation = new MutationObserver(observe);
    mutation.observe(tray, { childList: true, subtree: true, characterData: true });
    observe();
    return () => { resize.disconnect(); mutation.disconnect(); };
  }, [side]);
  return ref;
}
