import { describe, expect, it } from 'vitest';

import {
  diffPlotGrid,
  readPlotGridProjection,
  serializePlotGrid,
  type PlotGrid,
} from './plot-grid';

const GRID: PlotGrid = {
  rows: [
    { id: 'row-a', label: 'A' },
    { id: 'row-b', label: '' },
  ],
  cols: [
    { id: 'column-a', label: 'First' },
    { id: 'column-b', label: '' },
  ],
  cells: {
    'orphan:cell': 'ignored',
    'row-a:column-a': 'Beat',
  },
  cellW: 200,
  cellH: 80,
};

describe('normalized Plot Grid domain boundary', () => {
  it('treats empty or malformed JSON as no authority', () => {
    expect(readPlotGridProjection('{}')).toBeNull();
    expect(
      readPlotGridProjection(
        JSON.stringify({ ...GRID, rows: [{ id: 'duplicate', label: '' }, { id: 'duplicate', label: '' }] }),
      ),
    ).toBeNull();
  });

  it('serializes only deterministic sparse coordinates in row/column order', () => {
    const serialized = serializePlotGrid(GRID);
    expect(serialized).toBe(
      '{"rows":[{"id":"row-a","label":"A"},{"id":"row-b","label":""}],"cols":[{"id":"column-a","label":"First"},{"id":"column-b","label":""}],"cells":{"row-a:column-a":"Beat"},"cellW":200,"cellH":80}',
    );
    expect(readPlotGridProjection(serialized)).toEqual({
      ...GRID,
      cells: { 'row-a:column-a': 'Beat' },
    });
  });

  it('initializes through named size, axis, and cell mutations', () => {
    expect(diffPlotGrid(null, GRID)).toEqual([
      { type: 'size.set', cellW: 200, cellH: 80 },
      { type: 'row.add', row: { id: 'row-a', label: 'A' }, afterRowId: null },
      { type: 'row.add', row: { id: 'row-b', label: '' }, afterRowId: 'row-a' },
      {
        type: 'column.add',
        column: { id: 'column-a', label: 'First' },
        afterColumnId: null,
      },
      {
        type: 'column.add',
        column: { id: 'column-b', label: '' },
        afterColumnId: 'column-a',
      },
      {
        type: 'cell.value.set',
        rowId: 'row-a',
        columnId: 'column-a',
        value: 'Beat',
      },
    ]);
  });

  it('emits exact field/removal actions and rejects implicit reorder', () => {
    const next: PlotGrid = {
      ...GRID,
      rows: [{ id: 'row-b', label: 'B' }],
      cells: {},
    };
    expect(diffPlotGrid(GRID, next)).toEqual([
      { type: 'row.label.set', rowId: 'row-b', label: 'B' },
      { type: 'row.remove', rowId: 'row-a' },
    ]);

    expect(() =>
      diffPlotGrid(GRID, { ...GRID, rows: [...GRID.rows].reverse() }),
    ).toThrow('row reordering requires an explicit order.move writer');
  });
});
