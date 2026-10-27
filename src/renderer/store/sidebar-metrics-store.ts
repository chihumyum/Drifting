import { create } from 'zustand';
import type { SidebarSide } from '../lib/layout-geometry';

/** Current DOM/font measurements, never persisted as user preferences. Each
 * tab row of a split sidebar reports its own need; the side keeps the widest. */
export const useSidebarMetricsStore = create<{
  minimumWidths: Record<SidebarSide, number>;
  reports: Record<SidebarSide, Record<string, number>>;
  setMinimumWidth: (side: SidebarSide, width: number, source?: string) => void;
  clearMinimumWidth: (side: SidebarSide, source: string) => void;
}>((set) => {
  const settle = (
    state: { minimumWidths: Record<SidebarSide, number>; reports: Record<SidebarSide, Record<string, number>> },
    side: SidebarSide,
    reports: Record<string, number>,
  ) => {
    const width = Math.max(0, ...Object.values(reports));
    return {
      reports: { ...state.reports, [side]: reports },
      minimumWidths: state.minimumWidths[side] === width
        ? state.minimumWidths
        : { ...state.minimumWidths, [side]: width },
    };
  };
  return {
    minimumWidths: { left: 0, right: 0 },
    reports: { left: {}, right: {} },
    setMinimumWidth: (side, width, source = 'default') => set((state) => (
      state.reports[side][source] === width
        ? state
        : settle(state, side, { ...state.reports[side], [source]: width })
    )),
    clearMinimumWidth: (side, source) => set((state) => {
      if (!(source in state.reports[side])) return state;
      const rest = Object.fromEntries(
        Object.entries(state.reports[side]).filter(([key]) => key !== source),
      );
      return settle(state, side, rest);
    }),
  };
});
