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
 * Normalized plot_grid_* rows are authored truth. NodeContent.plotGridJson is
 * a deterministic, sparse UI projection rebuilt from those rows.
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

/** Named author actions accepted by the normalized Plot Grid writer. */
export type PlotGridMutation =
  | { readonly type: 'size.set'; readonly cellW: number; readonly cellH: number }
  | { readonly type: 'row.add'; readonly row: PlotAxis; readonly afterRowId: string | null }
  | { readonly type: 'row.label.set'; readonly rowId: string; readonly label: string }
  | { readonly type: 'row.remove'; readonly rowId: string }
  /** Explicit reorder: place an existing row right after `afterRowId` (null = first). */
  | { readonly type: 'row.move'; readonly rowId: string; readonly afterRowId: string | null }
  | { readonly type: 'column.add'; readonly column: PlotAxis; readonly afterColumnId: string | null }
  | { readonly type: 'column.label.set'; readonly columnId: string; readonly label: string }
  | { readonly type: 'column.remove'; readonly columnId: string }
  /** Explicit reorder: place an existing column right after `afterColumnId` (null = first). */
  | {
      readonly type: 'column.move';
      readonly columnId: string;
      readonly afterColumnId: string | null;
    }
  | {
      readonly type: 'cell.value.set';
      readonly rowId: string;
      readonly columnId: string;
      readonly value: string;
    };

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

function readAxes(raw: unknown): PlotAxis[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ids = new Set<string>();
  const axes: PlotAxis[] = [];
  for (const candidate of raw) {
    const axis = (candidate ?? {}) as Partial<PlotAxis>;
    if (
      typeof axis.id !== 'string' ||
      axis.id.length === 0 ||
      ids.has(axis.id) ||
      typeof axis.label !== 'string'
    ) {
      return null;
    }
    ids.add(axis.id);
    axes.push({ id: axis.id, label: axis.label });
  }
  return axes;
}

/** Read only a current normalized projection; malformed/empty values have no authority. */
export function readPlotGridProjection(json: string | null | undefined): PlotGrid | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Partial<PlotGrid>;
    const rows = readAxes(raw.rows);
    const cols = readAxes(raw.cols);
    if (!rows || !cols) return null;
    const cells: Record<string, string> = {};
    if (raw.cells && typeof raw.cells === 'object') {
      for (const row of rows) {
        for (const column of cols) {
          const key = cellKey(row.id, column.id);
          const value = (raw.cells as Record<string, unknown>)[key];
          if (typeof value === 'string' && value.length > 0) cells[key] = value;
        }
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
    return null;
  }
}

/** Tolerant UI parse; an absent projection starts a fresh local scratchpad. */
export function parsePlotGrid(json: string | null | undefined): PlotGrid {
  return readPlotGridProjection(json) ?? createEmptyPlotGrid();
}

export function clonePlotGrid(grid: PlotGrid): PlotGrid {
  return {
    rows: grid.rows.map((row) => ({ ...row })),
    cols: grid.cols.map((column) => ({ ...column })),
    cells: { ...grid.cells },
    cellW: grid.cellW,
    cellH: grid.cellH,
  };
}

export function serializePlotGrid(grid: PlotGrid): string {
  const cells: Record<string, string> = {};
  for (const row of grid.rows) {
    for (const column of grid.cols) {
      const key = cellKey(row.id, column.id);
      const value = grid.cells[key];
      if (typeof value === 'string' && value.length > 0) cells[key] = value;
    }
  }
  return JSON.stringify({
    rows: grid.rows.map(({ id, label }) => ({ id, label })),
    cols: grid.cols.map(({ id, label }) => ({ id, label })),
    cells,
    cellW: clampSize(grid.cellW, MIN_CELL_W, MAX_CELL_W, DEFAULT_CELL_W),
    cellH: clampSize(grid.cellH, MIN_CELL_H, MAX_CELL_H, DEFAULT_CELL_H),
  } satisfies PlotGrid);
}

/** Ids of the longest common subsequence of two id sequences (deterministic tie-break). */
function longestCommonSubsequence(a: readonly string[], b: readonly string[]): Set<string> {
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const kept = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      kept.add(a[i]!);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return kept;
}

/**
 * Axes whose relative order survived between two snapshots. Every other kept
 * axis becomes an explicit `move` placed right after its next-order
 * predecessor; applying those moves in next-order sequence reproduces `next`.
 */
function stableAxisIds(previous: readonly PlotAxis[], next: readonly PlotAxis[]): Set<string> {
  const previousIds = new Set(previous.map(({ id }) => id));
  const nextIds = new Set(next.map(({ id }) => id));
  return longestCommonSubsequence(
    previous.map(({ id }) => id).filter((id) => nextIds.has(id)),
    next.map(({ id }) => id).filter((id) => previousIds.has(id)),
  );
}

/** Move one axis by `delta` slots (UI helper for header menus). Returns the same array when a no-op. */
export function movePlotAxis(axes: readonly PlotAxis[], id: string, delta: -1 | 1): PlotAxis[] {
  const index = axes.findIndex((axis) => axis.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= axes.length) return [...axes];
  const next = [...axes];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

/**
 * Translate two UI snapshots into semantic author actions. Array position
 * identifies the predecessor of a newly-created axis and of every axis whose
 * relative order changed; the latter become explicit `row.move` /
 * `column.move` actions instead of an implicit whole-order replacement.
 */
export function diffPlotGrid(
  previous: PlotGrid | null,
  next: PlotGrid,
): readonly PlotGridMutation[] {
  if (next.rows.length === 0 || next.cols.length === 0) {
    throw new Error('Plot Grid must keep at least one row and one column');
  }
  const stableRows = previous ? stableAxisIds(previous.rows, next.rows) : new Set<string>();
  const stableColumns = previous ? stableAxisIds(previous.cols, next.cols) : new Set<string>();

  const mutations: PlotGridMutation[] = [];
  if (!previous || previous.cellW !== next.cellW || previous.cellH !== next.cellH) {
    mutations.push({ type: 'size.set', cellW: next.cellW, cellH: next.cellH });
  }

  const previousRows = new Map(previous?.rows.map((row) => [row.id, row]) ?? []);
  const previousColumns = new Map(previous?.cols.map((column) => [column.id, column]) ?? []);
  const nextRows = new Set(next.rows.map(({ id }) => id));
  const nextColumns = new Set(next.cols.map(({ id }) => id));

  next.rows.forEach((row, index) => {
    const prior = previousRows.get(row.id);
    if (!prior) {
      mutations.push({
        type: 'row.add',
        row: { ...row },
        afterRowId: next.rows[index - 1]?.id ?? null,
      });
      return;
    }
    if (!stableRows.has(row.id)) {
      mutations.push({
        type: 'row.move',
        rowId: row.id,
        afterRowId: next.rows[index - 1]?.id ?? null,
      });
    }
    if (prior.label !== row.label) {
      mutations.push({ type: 'row.label.set', rowId: row.id, label: row.label });
    }
  });
  next.cols.forEach((column, index) => {
    const prior = previousColumns.get(column.id);
    if (!prior) {
      mutations.push({
        type: 'column.add',
        column: { ...column },
        afterColumnId: next.cols[index - 1]?.id ?? null,
      });
      return;
    }
    if (!stableColumns.has(column.id)) {
      mutations.push({
        type: 'column.move',
        columnId: column.id,
        afterColumnId: next.cols[index - 1]?.id ?? null,
      });
    }
    if (prior.label !== column.label) {
      mutations.push({
        type: 'column.label.set',
        columnId: column.id,
        label: column.label,
      });
    }
  });

  for (const row of next.rows) {
    for (const column of next.cols) {
      const key = cellKey(row.id, column.id);
      const before = previous?.cells[key] ?? '';
      const after = next.cells[key] ?? '';
      if (before !== after) {
        mutations.push({
          type: 'cell.value.set',
          rowId: row.id,
          columnId: column.id,
          value: after,
        });
      }
    }
  }

  for (const row of previous?.rows ?? []) {
    if (!nextRows.has(row.id)) mutations.push({ type: 'row.remove', rowId: row.id });
  }
  for (const column of previous?.cols ?? []) {
    if (!nextColumns.has(column.id)) {
      mutations.push({ type: 'column.remove', columnId: column.id });
    }
  }
  return mutations;
}

/** True when the grid carries no author content (so we can skip persisting it). */
export function isPlotGridEmpty(grid: PlotGrid): boolean {
  if (Object.keys(grid.cells).length > 0) return false;
  if (grid.rows.some((r) => r.label.trim().length > 0)) return false;
  if (grid.cols.some((c) => c.label.trim().length > 0)) return false;
  return true;
}
