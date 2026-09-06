import { describe, expect, it } from 'vitest';

import type { PlotGrid } from '../../../domain/plot-grid';
import {
  PLOT_GRID_FIT_RATIO_TOLERANCE,
  clampPlotGridCellSize,
  fitPlotGridCellSize,
  plotGridCellLineClamp,
  plotGridCellPosition,
  plotGridNeighbor,
  plotGridView,
  plotGridVisualCellRatio,
  plotGridVisualCellSize,
  resolvePlotGridLayout,
  resolvePlotGridRowHeaderWidth,
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
      rowHeaderW: 60,
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
    const fit = fitPlotGridCellSize({
      width: 348,
      height: 588,
      rows: 5,
      cols: 3,
      presentation: 'mobile',
      rowHeaderW: 60,
    });
    expect(fit).toEqual({ cellW: 96, cellH: 110 });
    const layout = resolvePlotGridLayout({
      width: 348,
      height: 588,
      rows: 5,
      cols: 3,
      presentation: 'mobile',
      cellSize: fit,
      rowHeaderW: 60,
    });
    expect(layout).toMatchObject({ scrollX: false, scrollY: false, fitted: true });
  });

  it('clamps a fit to the presentation bounds so a crowded axis still overflows', () => {
    expect(
      fitPlotGridCellSize({ width: 348, height: 588, rows: 3, cols: 5, presentation: 'mobile', rowHeaderW: 60 }),
    ).toEqual({ cellW: 84, cellH: 184 });
    expect(
      fitPlotGridCellSize({ width: 900, height: 200, rows: 6, cols: 3, presentation: 'desktop', rowHeaderW: 96 }),
    ).toEqual({ cellW: 268, cellH: 56 });
    expect(clampPlotGridCellSize({ cellW: 9999, cellH: Number.NaN }, 'desktop')).toEqual({
      cellW: 440,
      cellH: 56,
    });
  });

  it('keeps a hand-set ratio and contains the table when the ratio is near the balanced one', () => {
    // Balanced fit here is 96 × 110 (ratio 0.87); 1:1 is within tolerance.
    const fit = fitPlotGridCellSize({
      width: 348,
      height: 588,
      rows: 5,
      cols: 3,
      presentation: 'mobile',
      rowHeaderW: 60,
      ratio: 1,
    });
    expect(fit).toEqual({ cellW: 96, cellH: 96 });
    const layout = resolvePlotGridLayout({
      width: 348,
      height: 588,
      rows: 5,
      cols: 3,
      presentation: 'mobile',
      cellSize: fit,
      rowHeaderW: 60,
      ratio: 1,
    });
    // Contained: the width binds, the rows leave slack; and fit is a no-op now.
    expect(layout).toMatchObject({ scrollX: false, scrollY: false, fitted: true });
    expect(
      resolvePlotGridLayout({
        width: 348,
        height: 588,
        rows: 5,
        cols: 3,
        presentation: 'mobile',
        cellSize: { cellW: 96, cellH: 110 },
        rowHeaderW: 60,
        ratio: 1,
      }).fitted,
    ).toBe(false);
  });

  it('fills only the short axis when the hand-set ratio is far from balanced', () => {
    // Balanced fit is 268 × 56 on desktop (ratio 4.8); the hand-set 1:1 is far
    // off, so fitting both axes would make strips. The rows fill the width
    // instead and the six rows overflow the 200px dock.
    expect(PLOT_GRID_FIT_RATIO_TOLERANCE).toBe(1.5);
    const fit = fitPlotGridCellSize({
      width: 900,
      height: 200,
      rows: 6,
      cols: 3,
      presentation: 'desktop',
      rowHeaderW: 96,
      ratio: 1,
    });
    expect(fit).toEqual({ cellW: 268, cellH: 268 });
    expect(
      resolvePlotGridLayout({
        width: 900,
        height: 200,
        rows: 6,
        cols: 3,
        presentation: 'desktop',
        cellSize: fit,
        rowHeaderW: 96,
        ratio: 1,
      }),
    ).toMatchObject({ scrollX: false, scrollY: true, fitted: true });
  });

  it('clamps a ratio-keeping fit along the ratio, breaking it only when the bounds cannot hold it', () => {
    // Very wide cells on the phone: the width maximum binds, the height follows.
    expect(
      fitPlotGridCellSize({ width: 348, height: 588, rows: 3, cols: 5, presentation: 'mobile', rowHeaderW: 60, ratio: 4 }),
    ).toEqual({ cellW: 440, cellH: 110 });
    // Tall cells at the width minimum keep their shape, so the rows overflow.
    expect(
      fitPlotGridCellSize({ width: 348, height: 588, rows: 3, cols: 5, presentation: 'mobile', rowHeaderW: 60, ratio: 0.25 }),
    ).toEqual({ cellW: 84, cellH: 336 });
    // A ratio no size within the bounds can express falls back to per-axis clamping.
    expect(
      fitPlotGridCellSize({ width: 348, height: 588, rows: 3, cols: 5, presentation: 'mobile', rowHeaderW: 60, ratio: 0.05 }),
    ).toEqual({ cellW: 84, cellH: 380 });
    // No ratio: each axis fits on its own, as before.
    expect(
      fitPlotGridCellSize({ width: 348, height: 588, rows: 5, cols: 3, presentation: 'mobile', rowHeaderW: 60, ratio: null }),
    ).toEqual({ cellW: 96, cellH: 110 });
  });

  it('hugs the widest row label between the presentation bounds', () => {
    expect(resolvePlotGridRowHeaderWidth(0, 'mobile')).toBe(44);
    expect(resolvePlotGridRowHeaderWidth(40, 'mobile')).toBe(58);
    expect(resolvePlotGridRowHeaderWidth(400, 'mobile')).toBe(132);
    expect(resolvePlotGridRowHeaderWidth(120, 'desktop')).toBe(138);
    expect(resolvePlotGridRowHeaderWidth(Number.NaN, 'desktop')).toBe(52);
  });

  it('derives the line clamp from the cell height', () => {
    expect(plotGridCellLineClamp(72)).toBe(2);
    expect(plotGridCellLineClamp(184)).toBe(8);
    expect(plotGridCellLineClamp(10)).toBe(1);
  });
});

describe('plot grid transposed view', () => {
  it('turns the cells with the table: size swaps, ratio inverts, and both map back', () => {
    const stored = { cellW: 300, cellH: 84 };
    expect(plotGridVisualCellSize(stored, false)).toBe(stored);
    expect(plotGridVisualCellSize(stored, true)).toEqual({ cellW: 84, cellH: 300 });
    expect(plotGridVisualCellSize(plotGridVisualCellSize(stored, true), true)).toEqual(stored);
    expect(plotGridVisualCellRatio(4, true)).toBe(0.25);
    expect(plotGridVisualCellRatio(4, false)).toBe(4);
    expect(plotGridVisualCellRatio(null, true)).toBeNull();
  });

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
