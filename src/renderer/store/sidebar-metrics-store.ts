import { create } from 'zustand';
import type { SidebarSide } from '../lib/layout-geometry';

/** Current DOM/font measurements, never persisted as user preferences. */
export const useSidebarMetricsStore = create<{
  minimumWidths: Record<SidebarSide, number>;
  setMinimumWidth: (side: SidebarSide, width: number) => void;
}>((set) => ({
  minimumWidths: { left: 0, right: 0 },
  setMinimumWidth: (side, width) => set((state) => (
    state.minimumWidths[side] === width ? state : {
      minimumWidths: { ...state.minimumWidths, [side]: width },
    }
  )),
}));
