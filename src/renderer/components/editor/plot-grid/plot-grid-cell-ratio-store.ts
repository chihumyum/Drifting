/**
 * The hand-set cell ratio (width / height) of one Plot Grid, kept per grid on
 * this device. Both presentations use it: the desktop size itself syncs
 * through the record, the phone size stays local, but "this shape was chosen
 * by hand, keep it when fitting" is a preference of the device the hand was
 * on. Absent (null) means fit may size both axes on its own.
 */
export const PLOT_GRID_CELL_RATIO_STORAGE_PREFIX = 'plot-grid-cell-ratio:';

export function readLocalPlotGridCellRatio(nodeId: string): number | null {
  try {
    const raw = localStorage.getItem(PLOT_GRID_CELL_RATIO_STORAGE_PREFIX + nodeId);
    if (!raw) return null;
    const ratio = Number(raw);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  } catch {
    return null;
  }
}

export function writeLocalPlotGridCellRatio(nodeId: string, ratio: number): void {
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  try {
    localStorage.setItem(PLOT_GRID_CELL_RATIO_STORAGE_PREFIX + nodeId, String(ratio));
  } catch {
    // Preference only.
  }
}
