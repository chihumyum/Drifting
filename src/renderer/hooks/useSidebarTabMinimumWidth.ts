import { useId, useLayoutEffect, useRef } from 'react';
import { sidebarTabMinimumWidth, type SidebarSide } from '../lib/layout-geometry';
import { useSidebarMetricsStore } from '../store/sidebar-metrics-store';

/** The rendered labels own the minimum, independent of a pane's stretched width.
 * Window controls absorbed into the same row (`data-sidebar-header-chrome`)
 * count too, so the tabs never slide under them. `windowChrome` says whether
 * this row carries them now: splitting or merging the sidebar moves them from
 * one row to another, and the row re-measures in that same commit, because the
 * split decision (DesktopSidebarLayout) reads the side's minimum before a
 * MutationObserver could report the change. */
export function useSidebarTabMinimumWidth(side: SidebarSide, windowChrome = false) {
  const ref = useRef<HTMLDivElement>(null);
  const source = useId();
  const measureNow = useRef<() => void>(() => {});
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
      const chromeWidth = chrome().reduce((sum, node) => {
        // The right toggle keeps 2px off the window edge (margin-right).
        const own = getComputedStyle(node);
        return sum + node.getBoundingClientRect().width + parseFloat(own.marginLeft) + parseFloat(own.marginRight) + rowGap;
      }, 0);
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
    measureNow.current = observe;
    return () => {
      measureNow.current = () => {};
      resize.disconnect();
      mutation.disconnect();
      useSidebarMetricsStore.getState().clearMinimumWidth(side, source);
    };
  }, [side, source]);
  useLayoutEffect(() => {
    measureNow.current();
  }, [windowChrome]);
  return ref;
}
