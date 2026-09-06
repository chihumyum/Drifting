import {
  MAX_CELL_H,
  MAX_CELL_W,
  MIN_CELL_H,
  MIN_CELL_W,
  cellKey,
  type PlotAxis,
  type PlotGrid,
} from '../../../domain/plot-grid';

/**
 * Plot Grid presentation geometry (shared by the desktop dock and the mobile
 * paper tool).
 *
 * Cells have a SIZE of their own. Adding rows or columns never squeezes the
 * existing cells: the table grows and the overflowing axis scrolls with the
 * opposite header pinned. "Fit" is an ACTION that computes the size at which
 * the whole table fills the host exactly, writes it into that size, and then
 * leaves it fixed again. The desktop size is the synced cellW / cellH record;
 * the mobile size is device-local (a phone-sized cell means nothing on a
 * desktop and vice versa), so each presentation carries its own bounds.
 */
export type PlotGridPresentation = 'desktop' | 'mobile';

export interface PlotGridCellSize {
  readonly cellW: number;
  readonly cellH: number;
}

export interface PlotGridLayoutMetrics {
  readonly minCellW: number;
  readonly minCellH: number;
  readonly maxCellW: number;
  readonly maxCellH: number;
  readonly rowHeaderW: number;
  readonly colHeaderH: number;
}

export const PLOT_GRID_LAYOUT_METRICS: Record<PlotGridPresentation, PlotGridLayoutMetrics> = {
  // Desktop bounds equal the domain record's bounds so every size is storable.
  desktop: {
    minCellW: MIN_CELL_W,
    minCellH: MIN_CELL_H,
    maxCellW: MAX_CELL_W,
    maxCellH: MAX_CELL_H,
    rowHeaderW: 96,
    colHeaderH: 30,
  },
  mobile: { minCellW: 84, minCellH: 72, maxCellW: 440, maxCellH: 380, rowHeaderW: 60, colHeaderH: 34 },
};

export function clampPlotGridCellSize(
  size: PlotGridCellSize,
  presentation: PlotGridPresentation,
): PlotGridCellSize {
  const metrics = PLOT_GRID_LAYOUT_METRICS[presentation];
  const clamp = (value: number, min: number, max: number, fallback: number) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  return {
    cellW: clamp(size.cellW, metrics.minCellW, metrics.maxCellW, metrics.minCellW),
    cellH: clamp(size.cellH, metrics.minCellH, metrics.maxCellH, metrics.minCellH),
  };
}

export interface PlotGridFitInput {
  readonly width: number;
  readonly height: number;
  readonly rows: number;
  readonly cols: number;
  readonly presentation: PlotGridPresentation;
}

/**
 * The cell size at which the table fills the host on both axes, clamped to the
 * presentation bounds (a crowded axis therefore still overflows at the
 * minimum). Callers store the result; it is a one-time action, not a mode.
 */
export function fitPlotGridCellSize({
  width,
  height,
  rows,
  cols,
  presentation,
}: PlotGridFitInput): PlotGridCellSize {
  const metrics = PLOT_GRID_LAYOUT_METRICS[presentation];
  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);
  const availableW = Math.max(0, width - metrics.rowHeaderW);
  const availableH = Math.max(0, height - metrics.colHeaderH);
  return clampPlotGridCellSize(
    { cellW: Math.floor(availableW / safeCols), cellH: Math.floor(availableH / safeRows) },
    presentation,
  );
}

export interface PlotGridLayoutInput extends PlotGridFitInput {
  readonly cellSize: PlotGridCellSize;
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
  /** True when the table already fills the host on both axes (fit is a no-op). */
  readonly fitted: boolean;
}

/** Lay the table out at its fixed cell size; whichever axis overflows scrolls. */
export function resolvePlotGridLayout({
  width,
  height,
  rows,
  cols,
  presentation,
  cellSize,
}: PlotGridLayoutInput): PlotGridLayout {
  const metrics = PLOT_GRID_LAYOUT_METRICS[presentation];
  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);
  const { cellW, cellH } = clampPlotGridCellSize(cellSize, presentation);
  const tableW = metrics.rowHeaderW + cellW * safeCols;
  const tableH = metrics.colHeaderH + cellH * safeRows;
  const fit = fitPlotGridCellSize({ width, height, rows, cols, presentation });
  return {
    cellW,
    cellH,
    rowHeaderW: metrics.rowHeaderW,
    colHeaderH: metrics.colHeaderH,
    scrollX: tableW > width + 0.5,
    scrollY: tableH > height + 0.5,
    tableW,
    tableH,
    fitted: fit.cellW === cellW && fit.cellH === cellH,
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
