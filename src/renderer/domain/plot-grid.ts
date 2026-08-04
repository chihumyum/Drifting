/**
 * Plot Grid — the in-chapter plot planner's data model.
 *
 * A lightweight "mini-Excel" scratchpad authored BEFORE/while writing a
 * chapter. The author owns the meaning of rows and columns (e.g. characters ×
 * time, or beats × detail) — we impose no semantics and bind to nothing. It is
 * deliberately decoupled from prose: NOT derived from the text (unlike
 * outlineJson / chapter summary) and never feeds Agent context automatically.
 *
 * Rows/cols carry stable ids so cells survive insert/delete without reindexing
 * and React keys stay stable across structural edits. Cells are stored sparsely
 * (key = `${rowId}:${colId}`) so an untouched grid costs almost nothing.
 *
 * Persisted per node as NodeContent.plotGridJson.
 */

export interface PlotAxis {
  id: string;
  /** Author-defined header label; '' = blank (renders placeholder). */
  label: string;
}

export interface PlotGrid {
  rows: PlotAxis[];
  cols: PlotAxis[];
  /** Cell text keyed by `${rowId}:${colId}`. Absent key = empty cell. */
  cells: Record<string, string>;
  /** Uniform cell width/height (px), set by dragging the table's corner grip. */
  cellW: number;
  cellH: number;
}

export const DEFAULT_GRID_ROWS = 3;
export const DEFAULT_GRID_COLS = 3;

export const DEFAULT_CELL_W = 184;
export const DEFAULT_CELL_H = 96;
export const MIN_CELL_W = 120;
export const MAX_CELL_W = 440;
export const MIN_CELL_H = 56;
export const MAX_CELL_H = 380;

function clampSize(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

let _idSeq = 0;
export function newAxisId(prefix: 'r' | 'c'): string {
  _idSeq += 1;
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}${rand}${_idSeq.toString(36)}`;
}

export function cellKey(rowId: string, colId: string): string {
  return `${rowId}:${colId}`;
}

export function createEmptyPlotGrid(): PlotGrid {
  return {
    rows: Array.from({ length: DEFAULT_GRID_ROWS }, () => ({ id: newAxisId('r'), label: '' })),
    cols: Array.from({ length: DEFAULT_GRID_COLS }, () => ({ id: newAxisId('c'), label: '' })),
    cells: {},
    cellW: DEFAULT_CELL_W,
    cellH: DEFAULT_CELL_H,
  };
}

function coerceAxes(raw: unknown, prefix: 'r' | 'c'): PlotAxis[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map((a) => {
    const obj = (a ?? {}) as Partial<PlotAxis>;
    return {
      id: typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : newAxisId(prefix),
      label: typeof obj.label === 'string' ? obj.label : '',
    };
  });
}

/** Tolerant parse of a stored plotGridJson string; never throws. */
export function parsePlotGrid(json: string | null | undefined): PlotGrid {
  if (!json) return createEmptyPlotGrid();
  try {
    const raw = JSON.parse(json) as Partial<PlotGrid>;
    const rows = coerceAxes(raw.rows, 'r');
    const cols = coerceAxes(raw.cols, 'c');
    if (!rows || !cols) return createEmptyPlotGrid();
    const cells: Record<string, string> = {};
    if (raw.cells && typeof raw.cells === 'object') {
      for (const [k, v] of Object.entries(raw.cells)) {
        if (typeof v === 'string' && v.length > 0) cells[k] = v;
      }
    }
    return {
      rows,
      cols,
      cells,
      cellW: clampSize(raw.cellW, MIN_CELL_W, MAX_CELL_W, DEFAULT_CELL_W),
      cellH: clampSize(raw.cellH, MIN_CELL_H, MAX_CELL_H, DEFAULT_CELL_H),
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
  if (grid.rows.some((r) => r.label.trim().length > 0)) return false;
  if (grid.cols.some((c) => c.label.trim().length > 0)) return false;
  return true;
}
