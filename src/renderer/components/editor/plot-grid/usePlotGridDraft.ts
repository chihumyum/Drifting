import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cellKey,
  movePlotAxis,
  newAxisId,
  parsePlotGrid,
  type PlotAxis,
  type PlotGrid,
} from '../../../domain/plot-grid';

export type PlotGridDataAxis = 'row' | 'col';

/**
 * Local working copy of one Plot Grid. Structure (rows / cols) is React state;
 * cell text lives in a ref so desktop inline typing never re-renders the table
 * and the caret never jumps. Every action emits a full snapshot for the host
 * to diff and persist. Actions speak in DATA axes; the transposed view maps
 * screen directions before calling in.
 */
export interface PlotGridDraft {
  readonly grid: PlotGrid;
  /** Bumps on structural or explicitly re-rendered cell changes. */
  readonly version: number;
  cellText(rowId: string, colId: string): string;
  setCell(rowId: string, colId: string, text: string, options?: { rerender?: boolean }): void;
  setLabel(axis: PlotGridDataAxis, id: string, label: string): void;
  /** Append one axis at the end; returns it. */
  add(axis: PlotGridDataAxis): PlotAxis;
  /** Insert one axis next to `id`; null when `id` is unknown. */
  insert(axis: PlotGridDataAxis, id: string, side: 'before' | 'after'): PlotAxis | null;
  /** False when the axis is the last one (a grid keeps ≥1 row and ≥1 column). */
  remove(axis: PlotGridDataAxis, id: string): boolean;
  /** Move one slot; false when already at the edge. */
  move(axis: PlotGridDataAxis, id: string, delta: -1 | 1): boolean;
  /** Ensure the grid has at least `rows` × `cols` axes (paste growth); returns the new axes. */
  grow(rows: number, cols: number): { rows: PlotAxis[]; cols: PlotAxis[] };
}

export function usePlotGridDraft(
  initialJson: string,
  onChange: (grid: PlotGrid) => void,
): PlotGridDraft {
  const [initial] = useState<PlotGrid>(() => parsePlotGrid(initialJson));
  const [rows, setRows] = useState<PlotAxis[]>(initial.rows);
  const [cols, setCols] = useState<PlotAxis[]>(initial.cols);
  const [version, setVersion] = useState(0);
  // `cells` mirrors the ref at every re-rendering commit point so render never
  // touches the ref; inline desktop typing only updates the ref (and the DOM).
  const [cells, setCells] = useState<Record<string, string>>(() => ({ ...initial.cells }));
  const rowsRef = useRef(rows);
  const colsRef = useRef(cols);
  const cellsRef = useRef<Record<string, string>>({ ...initial.cells });
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const emit = useCallback(() => {
    onChangeRef.current({
      rows: rowsRef.current,
      cols: colsRef.current,
      cells: { ...cellsRef.current },
      cellW: initial.cellW,
      cellH: initial.cellH,
    });
  }, [initial.cellH, initial.cellW]);

  const commitAxes = useCallback(
    (axis: PlotGridDataAxis, next: PlotAxis[]) => {
      if (axis === 'row') {
        rowsRef.current = next;
        setRows(next);
      } else {
        colsRef.current = next;
        setCols(next);
      }
      setCells({ ...cellsRef.current });
      setVersion((current) => current + 1);
      emit();
    },
    [emit],
  );

  const cellText = useCallback(
    (rowId: string, colId: string) => cellsRef.current[cellKey(rowId, colId)] ?? '',
    [],
  );

  const setCell = useCallback<PlotGridDraft['setCell']>(
    (rowId, colId, text, options) => {
      const key = cellKey(rowId, colId);
      if (text.length === 0) delete cellsRef.current[key];
      else cellsRef.current[key] = text;
      if (options?.rerender) {
        setCells({ ...cellsRef.current });
        setVersion((current) => current + 1);
      }
      emit();
    },
    [emit],
  );

  const setLabel = useCallback<PlotGridDraft['setLabel']>(
    (axis, id, label) => {
      const current = axis === 'row' ? rowsRef.current : colsRef.current;
      if (!current.some((item) => item.id === id && item.label !== label)) return;
      commitAxes(
        axis,
        current.map((item) => (item.id === id ? { ...item, label } : item)),
      );
    },
    [commitAxes],
  );

  const add = useCallback<PlotGridDraft['add']>(
    (axis) => {
      const created = { id: newAxisId(axis === 'row' ? 'r' : 'c'), label: '' };
      commitAxes(axis, [...(axis === 'row' ? rowsRef.current : colsRef.current), created]);
      return created;
    },
    [commitAxes],
  );

  const insert = useCallback<PlotGridDraft['insert']>(
    (axis, id, side) => {
      const current = axis === 'row' ? rowsRef.current : colsRef.current;
      const index = current.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const created = { id: newAxisId(axis === 'row' ? 'r' : 'c'), label: '' };
      const next = [...current];
      next.splice(side === 'before' ? index : index + 1, 0, created);
      commitAxes(axis, next);
      return created;
    },
    [commitAxes],
  );

  const remove = useCallback<PlotGridDraft['remove']>(
    (axis, id) => {
      const current = axis === 'row' ? rowsRef.current : colsRef.current;
      if (current.length <= 1 || !current.some((item) => item.id === id)) return false;
      const opposite = axis === 'row' ? colsRef.current : rowsRef.current;
      for (const other of opposite) {
        delete cellsRef.current[axis === 'row' ? cellKey(id, other.id) : cellKey(other.id, id)];
      }
      commitAxes(
        axis,
        current.filter((item) => item.id !== id),
      );
      return true;
    },
    [commitAxes],
  );

  const move = useCallback<PlotGridDraft['move']>(
    (axis, id, delta) => {
      const current = axis === 'row' ? rowsRef.current : colsRef.current;
      const next = movePlotAxis(current, id, delta);
      if (next.every((item, index) => item.id === current[index]?.id)) return false;
      commitAxes(axis, next);
      return true;
    },
    [commitAxes],
  );

  const grow = useCallback<PlotGridDraft['grow']>(
    (rowCount, colCount) => {
      const nextRows = [...rowsRef.current];
      const nextCols = [...colsRef.current];
      while (nextRows.length < rowCount) nextRows.push({ id: newAxisId('r'), label: '' });
      while (nextCols.length < colCount) nextCols.push({ id: newAxisId('c'), label: '' });
      if (nextRows.length !== rowsRef.current.length) {
        rowsRef.current = nextRows;
        setRows(nextRows);
      }
      if (nextCols.length !== colsRef.current.length) {
        colsRef.current = nextCols;
        setCols(nextCols);
      }
      setCells({ ...cellsRef.current });
      return { rows: nextRows, cols: nextCols };
    },
    [],
  );

  const grid = useMemo<PlotGrid>(
    () => ({ rows, cols, cells, cellW: initial.cellW, cellH: initial.cellH }),
    [rows, cols, cells, initial.cellH, initial.cellW],
  );

  return useMemo(
    () => ({ grid, version, cellText, setCell, setLabel, add, insert, remove, move, grow }),
    [grid, version, cellText, setCell, setLabel, add, insert, remove, move, grow],
  );
}
