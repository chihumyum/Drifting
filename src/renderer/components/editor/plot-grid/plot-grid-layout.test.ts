import { describe, expect, it } from 'vitest';

import type { PlotGrid } from '../../../domain/plot-grid';
import {
  plotGridCellLineClamp,
  plotGridCellPosition,
  plotGridNeighbor,
  plotGridView,
  resolvePlotGridLayout,
} from './plot-grid-layout';

const GRID: PlotGrid = {
  rows: [
    { id: 'r1', label: '守塔人' },
    { id: 'r2', label: '我' },
    { id: 'r3', label: '来客' },
  ],
  cols: [
    { id: 'c1', label: '第一夜' },
    { id: 'c2', label: '第二夜' },
    { id: 'c3', label: '第三夜' },
    { id: 'c4', label: '退潮' },
    { id: 'c5', label: '尾声' },
  ],
  cells: { 'r1:c2': '把表交给我' },
  cellW: 184,
  cellH: 96,
};

describe('plot grid fill layout', () => {
  it('stretches cells to fill the mobile body when everything fits', () => {
    const layout = resolvePlotGridLayout({
      width: 348,
      height: 588,
      rows: 5,
      cols: 3,
      presentation: 'mobile',
    });
    expect(layout).toMatchObject({ cellW: 96, cellH: 110, scrollX: false, scrollY: false });
    expect(layout.tableW).toBe(60 + 96 * 3);
  });

  it('pins the minimum width and scrolls horizontally when columns overflow', () => {
    const layout = resolvePlotGridLayout({
      width: 348,
      height: 588,
      rows: 3,
      cols: 5,
      presentation: 'mobile',
    });
    expect(layout).toMatchObject({ cellW: 84, cellH: 184, scrollX: true, scrollY: false });
    expect(layout.tableW).toBe(60 + 84 * 5);
  });

  it('scrolls vertically when rows overflow and keeps the desktop minimums', () => {
    const layout = resolvePlotGridLayout({
      width: 900,
      height: 200,
      rows: 6,
      cols: 3,
      presentation: 'desktop',
    });
    expect(layout).toMatchObject({ cellW: 268, cellH: 64, scrollX: false, scrollY: true });
  });

  it('derives the line clamp from the cell height', () => {
    expect(plotGridCellLineClamp(72)).toBe(2);
    expect(plotGridCellLineClamp(184)).toBe(8);
    expect(plotGridCellLineClamp(10)).toBe(1);
  });
});

describe('plot grid transposed view', () => {
  it('swaps axes without touching data coordinates', () => {
    const view = plotGridView(GRID, true);
    expect(view.rows.map(({ id }) => id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(view.cols.map(({ id }) => id)).toEqual(['r1', 'r2', 'r3']);
    expect(view.dataCell('c2', 'r1')).toEqual({ rowId: 'r1', colId: 'c2' });
    expect(view.cellText('c2', 'r1')).toBe('把表交给我');
    expect(view.dataAxis('row')).toBe('col');
    expect(plotGridView(GRID, false).dataAxis('row')).toBe('row');
  });

  it('walks neighbours in visual directions in both orientations', () => {
    const plain = plotGridView(GRID, false);
    expect(plotGridNeighbor(plain, { rowId: 'r1', colId: 'c2' }, 'right')).toEqual({
      rowId: 'r1',
      colId: 'c3',
    });
    expect(plotGridNeighbor(plain, { rowId: 'r1', colId: 'c2' }, 'up')).toBeNull();
    const transposed = plotGridView(GRID, true);
    expect(plotGridNeighbor(transposed, { rowId: 'r1', colId: 'c2' }, 'down')).toEqual({
      rowId: 'r1',
      colId: 'c3',
    });
    expect(plotGridNeighbor(transposed, { rowId: 'r1', colId: 'c2' }, 'right')).toEqual({
      rowId: 'r2',
      colId: 'c2',
    });
    expect(plotGridCellPosition(transposed, { rowId: 'r1', colId: 'c2' })).toEqual({
      rowIndex: 2,
      rowCount: 5,
      colIndex: 1,
      colCount: 3,
    });
  });
});
