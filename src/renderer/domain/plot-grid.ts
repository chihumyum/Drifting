/**
 * Plot Grid — the in-chapter plot planner's data model.
 *
 * A lightweight "mini-Excel" scratchpad authored BEFORE/while writing a
 * chapter. The author owns the meaning of rows and columns (e.g. characters ×
 * time, or beats × detail) — we impose no semantics and bind to nothing. It is
 * deliberately decoupled from prose: it is NOT derived from the text (unlike
 * outlineJson / chapter summary) and never feeds the dep-graph or shadow.
 *
 * Persisted per node as NodeContent.plotGridJson. Cells are stored sparsely so
 * an untouched grid costs (almost) nothing.
 */

export interface PlotGrid {
  rows: number;
  cols: number;
  /** Optional header labels, index-aligned to rows. Sparse / may be shorter. */
  rowHeaders?: string[];
  /** Optional header labels, index-aligned to cols. Sparse / may be shorter. */
  colHeaders?: string[];
  /** Cell text keyed by `"${row},${col}"` (0-based). Absent key = empty cell. */
  cells: Record<string, string>;
}

export const DEFAULT_GRID_ROWS = 3;
export const DEFAULT_GRID_COLS = 3;

export function createEmptyPlotGrid(): PlotGrid {
  return { rows: DEFAULT_GRID_ROWS, cols: DEFAULT_GRID_COLS, cells: {} };
}

export function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

/** Tolerant parse of a stored plotGridJson string; never throws. */
export function parsePlotGrid(json: string | null | undefined): PlotGrid {
  if (!json) return createEmptyPlotGrid();
  try {
    const raw = JSON.parse(json) as Partial<PlotGrid>;
    const rows = Number.isFinite(raw.rows) ? Math.max(1, Math.floor(raw.rows as number)) : DEFAULT_GRID_ROWS;
    const cols = Number.isFinite(raw.cols) ? Math.max(1, Math.floor(raw.cols as number)) : DEFAULT_GRID_COLS;
    const cells: Record<string, string> = {};
    if (raw.cells && typeof raw.cells === 'object') {
      for (const [k, v] of Object.entries(raw.cells)) {
        if (typeof v === 'string' && v.length > 0) cells[k] = v;
      }
    }
    return {
      rows,
      cols,
      rowHeaders: Array.isArray(raw.rowHeaders) ? raw.rowHeaders.map((h) => String(h ?? '')) : undefined,
      colHeaders: Array.isArray(raw.colHeaders) ? raw.colHeaders.map((h) => String(h ?? '')) : undefined,
      cells,
    };
  } catch {
    return createEmptyPlotGrid();
  }
}

export function serializePlotGrid(grid: PlotGrid): string {
  return JSON.stringify(grid);
}

/** True when the grid carries no author content (so we can skip persisting it). */
export function isPlotGridEmpty(grid: PlotGrid): boolean {
  if (Object.keys(grid.cells).length > 0) return false;
  if (grid.rowHeaders?.some((h) => h.trim().length > 0)) return false;
  if (grid.colHeaders?.some((h) => h.trim().length > 0)) return false;
  return true;
}
