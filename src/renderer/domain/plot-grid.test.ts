import { describe, expect, it } from 'vitest';

import {
  diffPlotGrid,
  movePlotAxis,
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

  it('emits exact field/removal actions and explicit moves for a changed relative order', () => {
    const next: PlotGrid = {
      ...GRID,
      rows: [{ id: 'row-b', label: 'B' }],
      cells: {},
    };
    expect(diffPlotGrid(GRID, next)).toEqual([
      { type: 'row.label.set', rowId: 'row-b', label: 'B' },
      { type: 'row.remove', rowId: 'row-a' },
    ]);

    expect(diffPlotGrid(GRID, { ...GRID, rows: [...GRID.rows].reverse() })).toEqual([
      { type: 'row.move', rowId: 'row-a', afterRowId: 'row-b' },
    ]);
    expect(diffPlotGrid(GRID, { ...GRID, cols: [...GRID.cols].reverse() })).toEqual([
      { type: 'column.move', columnId: 'column-a', afterColumnId: 'column-b' },
    ]);
  });

  it('derives moves whose sequential application reproduces the next order', () => {
    const axes = (ids: string) => ids.split('').map((id) => ({ id, label: '' }));
    const applyRowMoves = (from: string, mutations: readonly ReturnType<typeof diffPlotGrid>[number][]) => {
      const order = from.split('');
      for (const mutation of mutations) {
        if (mutation.type === 'row.add') {
          const at = mutation.afterRowId ? order.indexOf(mutation.afterRowId) + 1 : 0;
          order.splice(at, 0, mutation.row.id);
        } else if (mutation.type === 'row.move') {
          order.splice(order.indexOf(mutation.rowId), 1);
          const at = mutation.afterRowId ? order.indexOf(mutation.afterRowId) + 1 : 0;
          order.splice(at, 0, mutation.rowId);
        } else if (mutation.type === 'row.remove') {
          order.splice(order.indexOf(mutation.rowId), 1);
        }
      }
      return order.join('');
    };
    const cases: Array<[string, string]> = [
      ['abcd', 'bdac'],
      ['abcd', 'dcba'],
      ['abcd', 'acbd'],
      ['abcde', 'ebadc'],
      ['abc', 'cxab'],
      ['abcd', 'db'],
    ];
    for (const [from, to] of cases) {
      const previous: PlotGrid = { ...GRID, rows: axes(from), cells: {} };
      const next: PlotGrid = { ...GRID, rows: axes(to), cells: {} };
      const mutations = diffPlotGrid(previous, next);
      expect(applyRowMoves(from, mutations), `${from} -> ${to}`).toBe(to);
      expect(mutations.filter((m) => m.type === 'row.move').length, `${from} -> ${to}`).toBeLessThan(
        to.length,
      );
    }
    expect(diffPlotGrid({ ...GRID, rows: axes('abcd') }, { ...GRID, rows: axes('abcd') })).toEqual(
      [],
    );
  });

  it('moves one axis by one slot for header menus', () => {
    const axes = 'abc'.split('').map((id) => ({ id, label: id }));
    expect(movePlotAxis(axes, 'b', 1).map(({ id }) => id)).toEqual(['a', 'c', 'b']);
    expect(movePlotAxis(axes, 'b', -1).map(({ id }) => id)).toEqual(['b', 'a', 'c']);
    expect(movePlotAxis(axes, 'a', -1).map(({ id }) => id)).toEqual(['a', 'b', 'c']);
    expect(movePlotAxis(axes, 'missing', 1).map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });
});
