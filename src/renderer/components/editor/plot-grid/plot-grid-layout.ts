import { cellKey, type PlotAxis, type PlotGrid } from '../../../domain/plot-grid';

/**
 * Plot Grid presentation geometry (shared by the desktop dock and the mobile
 * paper tool). The table always fills the host's body: cells stretch on both
 * axes down to a per-presentation minimum, then the overflowing axis scrolls
 * while its opposite header stays pinned. `cellW` / `cellH` in the domain
 * record are the retired corner-grip preferences and no longer drive layout.
 */
export type PlotGridPresentation = 'desktop' | 'mobile';

export interface PlotGridLayoutMetrics {
  readonly minCellW: number;
  readonly minCellH: number;
  readonly rowHeaderW: number;
  readonly colHeaderH: number;
}

export const PLOT_GRID_LAYOUT_METRICS: Record<PlotGridPresentation, PlotGridLayoutMetrics> = {
  desktop: { minCellW: 120, minCellH: 64, rowHeaderW: 96, colHeaderH: 30 },
  mobile: { minCellW: 84, minCellH: 72, rowHeaderW: 60, colHeaderH: 34 },
};

export interface PlotGridLayoutInput {
  readonly width: number;
  readonly height: number;
  readonly rows: number;
  readonly cols: number;
  readonly presentation: PlotGridPresentation;
}

export interface PlotGridLayout {
  readonly cellW: number;
  readonly cellH: number;
  readonly rowHeaderW: number;
  readonly colHeaderH: number;
  /** The columns overflow the width: scroll horizontally, row header pinned. */
  readonly scrollX: boolean;
  /** The rows overflow the height: scroll vertically, column header pinned. */
  readonly scrollY: boolean;
  readonly tableW: number;
  readonly tableH: number;
}

/** Fill both axes; clamp at the minimum and let that axis scroll. */
export function resolvePlotGridLayout({
  width,
  height,
  rows,
  cols,
  presentation,
}: PlotGridLayoutInput): PlotGridLayout {
  const metrics = PLOT_GRID_LAYOUT_METRICS[presentation];
  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);
  const availableW = Math.max(0, width - metrics.rowHeaderW);
  const availableH = Math.max(0, height - metrics.colHeaderH);
  const fillW = Math.floor(availableW / safeCols);
  const fillH = Math.floor(availableH / safeRows);
  const cellW = Math.max(metrics.minCellW, fillW);
  const cellH = Math.max(metrics.minCellH, fillH);
  return {
    cellW,
    cellH,
    rowHeaderW: metrics.rowHeaderW,
    colHeaderH: metrics.colHeaderH,
    scrollX: cellW * safeCols > availableW + 0.5,
    scrollY: cellH * safeRows > availableH + 0.5,
    tableW: metrics.rowHeaderW + cellW * safeCols,
    tableH: metrics.colHeaderH + cellH * safeRows,
  };
}

/** Lines of body text that fit one cell (used for the mobile clamp). */
export function plotGridCellLineClamp(cellH: number, lineHeightPx = 19, paddingPx = 16): number {
  return Math.max(1, Math.floor((cellH - paddingPx) / lineHeightPx));
}

export type PlotGridVisualAxis = 'row' | 'col';

/**
 * A view over the grid in screen orientation. The transposed view swaps the
 * author's rows and columns without touching the data: a visual row is then a
 * data column. Every host action speaks in visual terms and maps back here.
 */
export interface PlotGridView {
  readonly transposed: boolean;
  readonly rows: readonly PlotAxis[];
  readonly cols: readonly PlotAxis[];
  /** Visual (row, col) → data (rowId, colId). */
  dataCell(visualRowId: string, visualColId: string): { rowId: string; colId: string };
  /** Visual axis → data axis. */
  dataAxis(axis: PlotGridVisualAxis): PlotGridVisualAxis;
  cellText(visualRowId: string, visualColId: string): string;
}

export function plotGridView(grid: PlotGrid, transposed: boolean): PlotGridView {
  const rows = transposed ? grid.cols : grid.rows;
  const cols = transposed ? grid.rows : grid.cols;
  const dataCell = (visualRowId: string, visualColId: string) =>
    transposed
      ? { rowId: visualColId, colId: visualRowId }
      : { rowId: visualRowId, colId: visualColId };
  return {
    transposed,
    rows,
    cols,
    dataCell,
    dataAxis: (axis) => (transposed ? (axis === 'row' ? 'col' : 'row') : axis),
    cellText: (visualRowId, visualColId) => {
      const { rowId, colId } = dataCell(visualRowId, visualColId);
      return grid.cells[cellKey(rowId, colId)] ?? '';
    },
  };
}

export type PlotGridDirection = 'left' | 'right' | 'up' | 'down';

/** Neighbouring data cell in a visual direction; null at the edge. */
export function plotGridNeighbor(
  view: PlotGridView,
  cell: { rowId: string; colId: string },
  direction: PlotGridDirection,
): { rowId: string; colId: string } | null {
  const visualRowId = view.transposed ? cell.colId : cell.rowId;
  const visualColId = view.transposed ? cell.rowId : cell.colId;
  const rowIndex = view.rows.findIndex((axis) => axis.id === visualRowId);
  const colIndex = view.cols.findIndex((axis) => axis.id === visualColId);
  if (rowIndex < 0 || colIndex < 0) return null;
  const nextRow =
    direction === 'up' ? rowIndex - 1 : direction === 'down' ? rowIndex + 1 : rowIndex;
  const nextCol =
    direction === 'left' ? colIndex - 1 : direction === 'right' ? colIndex + 1 : colIndex;
  const row = view.rows[nextRow];
  const col = view.cols[nextCol];
  if (!row || !col) return null;
  return view.dataCell(row.id, col.id);
}

export interface PlotGridCellPosition {
  readonly rowIndex: number;
  readonly rowCount: number;
  readonly colIndex: number;
  readonly colCount: number;
}

/** 1-based visual position of a data cell (for the editing sheet caption). */
export function plotGridCellPosition(
  view: PlotGridView,
  cell: { rowId: string; colId: string },
): PlotGridCellPosition | null {
  const visualRowId = view.transposed ? cell.colId : cell.rowId;
  const visualColId = view.transposed ? cell.rowId : cell.colId;
  const rowIndex = view.rows.findIndex((axis) => axis.id === visualRowId);
  const colIndex = view.cols.findIndex((axis) => axis.id === visualColId);
  if (rowIndex < 0 || colIndex < 0) return null;
  return {
    rowIndex: rowIndex + 1,
    rowCount: view.rows.length,
    colIndex: colIndex + 1,
    colCount: view.cols.length,
  };
}
