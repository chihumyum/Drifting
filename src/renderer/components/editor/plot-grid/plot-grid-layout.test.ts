import { describe, expect, it } from 'vitest';

import type { PlotGrid } from '../../../domain/plot-grid';
import {
  clampPlotGridCellSize,
  fitPlotGridCellSize,
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

describe('plot grid fixed-size layout', () => {
  it('lays the table out at its own cell size and scrolls only the overflowing axis', () => {
    const layout = resolvePlotGridLayout({
      width: 348,
      height: 588,
      rows: 3,
      cols: 5,
      presentation: 'mobile',
      cellSize: { cellW: 96, cellH: 110 },
    });
    expect(layout).toMatchObject({ cellW: 96, cellH: 110, scrollX: true, scrollY: false, fitted: false });
    expect(layout.tableW).toBe(60 + 96 * 5);
    expect(layout.tableH).toBe(34 + 110 * 3);
  });

  it('never squeezes cells when rows or columns are added', () => {
    const before = resolvePlotGridLayout({
      width: 900,
      height: 280,
      rows: 3,
      cols: 3,
      presentation: 'desktop',
      cellSize: { cellW: 184, cellH: 96 },
    });
    const after = resolvePlotGridLayout({
      width: 900,
      height: 280,
      rows: 6,
      cols: 6,
      presentation: 'desktop',
      cellSize: { cellW: 184, cellH: 96 },
    });
    expect(after.cellW).toBe(before.cellW);
    expect(after.cellH).toBe(before.cellH);
    expect(after).toMatchObject({ scrollX: true, scrollY: true });
  });

  it('fits the whole table into the host on both axes and reports it as fitted', () => {
    const fit = fitPlotGridCellSize({ width: 348, height: 588, rows: 5, cols: 3, presentation: 'mobile' });
    expect(fit).toEqual({ cellW: 96, cellH: 110 });
    const layout = resolvePlotGridLayout({
      width: 348,
      height: 588,
      rows: 5,
      cols: 3,
      presentation: 'mobile',
      cellSize: fit,
    });
    expect(layout).toMatchObject({ scrollX: false, scrollY: false, fitted: true });
  });

  it('clamps a fit to the presentation bounds so a crowded axis still overflows', () => {
    expect(fitPlotGridCellSize({ width: 348, height: 588, rows: 3, cols: 5, presentation: 'mobile' })).toEqual({
      cellW: 84,
      cellH: 184,
    });
    expect(fitPlotGridCellSize({ width: 900, height: 200, rows: 6, cols: 3, presentation: 'desktop' })).toEqual({
      cellW: 268,
      cellH: 56,
    });
    expect(clampPlotGridCellSize({ cellW: 9999, cellH: Number.NaN }, 'desktop')).toEqual({
      cellW: 440,
      cellH: 56,
    });
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
