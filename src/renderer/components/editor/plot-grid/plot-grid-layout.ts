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
 * existing cells: the table grows and the overflowing axis scrolls. "Fit" is
 * an ACTION that computes the size at which the whole table fills the host,
 * writes it into that size, and then leaves it fixed again. The desktop size
 * is the synced cellW / cellH record; the mobile size is device-local (a
 * phone-sized cell means nothing on a desktop and vice versa), so each
 * presentation carries its own bounds.
 *
 * A size set BY HAND (grip, pinch) also fixes the cell's aspect RATIO, kept
 * device-local per grid. A later fit keeps that ratio and only scales: when
 * the ratio is close to the one that would fill both axes, the table scales
 * to be contained; when it is far from it, fitting both axes would turn the
 * cells into strips, so only the short axis is filled and the long axis
 * overflows and scrolls.
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
  /** Default row header width; the editor measures labels and overrides it. */
  readonly rowHeaderW: number;
  readonly minRowHeaderW: number;
  readonly maxRowHeaderW: number;
  readonly colHeaderH: number;
}

export const PLOT_GRID_LAYOUT_METRICS: Record<PlotGridPresentation, PlotGridLayoutMetrics> = {
  // Desktop bounds equal the domain record's bounds so every size is storable.
  desktop: {
    minCellW: MIN_CELL_W,
    minCellH: MIN_CELL_H,
    maxCellW: MAX_CELL_W,
    maxCellH: MAX_CELL_H,
    rowHeaderW: 72,
    minRowHeaderW: 52,
    maxRowHeaderW: 220,
    colHeaderH: 30,
  },
  mobile: {
    minCellW: 84,
    minCellH: 72,
    maxCellW: 440,
    maxCellH: 380,
    rowHeaderW: 56,
    minRowHeaderW: 44,
    maxRowHeaderW: 132,
    colHeaderH: 34,
  },
};

/**
 * Row header width from the widest measured label: hugs short labels, grows
 * with long ones, and caps at the presentation maximum so a very long label
 * wraps onto further lines instead of stealing the table's width.
 */
export function resolvePlotGridRowHeaderWidth(
  widestLabelPx: number,
  presentation: PlotGridPresentation,
  paddingPx = 18,
): number {
  const metrics = PLOT_GRID_LAYOUT_METRICS[presentation];
  const measured = Number.isFinite(widestLabelPx) ? widestLabelPx : 0;
  return Math.min(
    metrics.maxRowHeaderW,
    Math.max(metrics.minRowHeaderW, Math.ceil(measured + paddingPx)),
  );
}

/** The hand-set cell shape, width over height. */
export function plotGridCellRatio(size: PlotGridCellSize): number {
  return size.cellW / size.cellH;
}

/**
 * The stored size and ratio live in the author's frame (rows down, columns
 * across). The transposed view turns the whole table, cells included, so on
 * screen the width and height swap and the ratio inverts. Both mappings are
 * their own inverse: the same call maps a screen value back to storage.
 */
export function plotGridVisualCellSize(size: PlotGridCellSize, transposed: boolean): PlotGridCellSize {
  return transposed ? { cellW: size.cellH, cellH: size.cellW } : size;
}

export function plotGridVisualCellRatio(ratio: number | null, transposed: boolean): number | null {
  return transposed && ratio !== null && ratio > 0 ? 1 / ratio : ratio;
}

/**
 * How far a hand-set ratio may sit from the balanced (both-axes) fit before a
 * ratio-keeping fit stops containing the table and fills the short axis only.
 */
export const PLOT_GRID_FIT_RATIO_TOLERANCE = 1.5;

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
  /** Measured row header width (see resolvePlotGridRowHeaderWidth). */
  readonly rowHeaderW?: number;
  /** A hand-set cell ratio (width / height) the fit must keep; null fits both axes. */
  readonly ratio?: number | null;
}

/**
 * The cell size at which the table fills the host, clamped to the presentation
 * bounds (a crowded axis therefore still overflows at the minimum). Without a
 * hand-set ratio each axis fits on its own; with one, the cells only scale
 * (see the module note). Callers store the result; it is a one-time action,
 * not a mode.
 */
export function fitPlotGridCellSize({
  width,
  height,
  rows,
  cols,
  presentation,
  rowHeaderW,
  ratio = null,
}: PlotGridFitInput): PlotGridCellSize {
  const metrics = PLOT_GRID_LAYOUT_METRICS[presentation];
  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);
  const availableW = Math.max(0, width - (rowHeaderW ?? metrics.rowHeaderW));
  const availableH = Math.max(0, height - metrics.colHeaderH);
  if (ratio !== null && Number.isFinite(ratio) && ratio > 0) {
    // Both candidates are cell heights: the one that fills the width at this
    // ratio and the one that fills the height.
    const byWidth = availableW / (safeCols * ratio);
    const byHeight = availableH / safeRows;
    const short = Math.min(byWidth, byHeight);
    const long = Math.max(byWidth, byHeight);
    const balanced = short > 0 && long / short <= PLOT_GRID_FIT_RATIO_TOLERANCE;
    let cellH = balanced ? short : long;
    // Clamp along the ratio so the shape survives whenever the bounds allow.
    const minH = Math.max(metrics.minCellH, metrics.minCellW / ratio);
    const maxH = Math.min(metrics.maxCellH, metrics.maxCellW / ratio);
    if (minH <= maxH) cellH = Math.min(maxH, Math.max(minH, cellH));
    cellH = Math.floor(cellH);
    return clampPlotGridCellSize({ cellW: Math.floor(cellH * ratio), cellH }, presentation);
  }
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
  /** True when the current size is what fit would produce (fit is a no-op). */
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
  rowHeaderW,
  ratio = null,
}: PlotGridLayoutInput): PlotGridLayout {
  const metrics = PLOT_GRID_LAYOUT_METRICS[presentation];
  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);
  const { cellW, cellH } = clampPlotGridCellSize(cellSize, presentation);
  const headerW = rowHeaderW ?? metrics.rowHeaderW;
  const tableW = headerW + cellW * safeCols;
  const tableH = metrics.colHeaderH + cellH * safeRows;
  const fit = fitPlotGridCellSize({ width, height, rows, cols, presentation, rowHeaderW: headerW, ratio });
  return {
    cellW,
    cellH,
    rowHeaderW: headerW,
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
