import { describe, expect, it } from 'vitest';

import { cellKey, type PlotGrid } from '../../domain/plot-grid';
import { parsePlotGridMarkdown, planPlotGrid, plotGridToMarkdown } from './plot-grid-markdown';

const grid: PlotGrid = {
  rows: [
    { id: 'r1', label: '开场' },
    { id: 'r2', label: '' },
  ],
  cols: [
    { id: 'c1', label: '林默' },
    { id: 'c2', label: 'A|B' },
  ],
  cells: { [cellKey('r1', 'c1')]: '到达\n灯塔', [cellKey('r2', 'c2')]: 'x' },
  cellW: 200,
  cellH: 100,
};

describe('plot grid Markdown', () => {
  it('round-trips labels, empty cells, pipes and line breaks', () => {
    const markdown = plotGridToMarkdown(grid);
    expect(markdown).toBe('|  | 林默 | A\\|B |\n| --- | --- | --- |\n| 开场 | 到达<br>灯塔 |  |\n|  |  | x |');
    expect(parsePlotGridMarkdown(markdown)).toEqual({
      columns: ['林默', 'A|B'],
      rows: [
        { label: '开场', cells: ['到达\n灯塔', ''] },
        { label: '', cells: ['', 'x'] },
      ],
    });
  });

  it('keeps axes by label, then by position, and mints the rest', () => {
    let next = 0;
    const planned = planPlotGrid(
      grid,
      { columns: ['新列', '林默', '第三列'], rows: [{ label: '开场', cells: ['a', 'b', 'c'] }] },
      (prefix) => `${prefix}new${++next}`,
    );
    expect(planned.cols.map((column) => column.id)).toEqual(['c2', 'c1', 'cnew1']);
    expect(planned.rows.map((row) => row.id)).toEqual(['r1']);
    expect(planned.cells).toEqual({
      [cellKey('r1', 'c2')]: 'a',
      [cellKey('r1', 'c1')]: 'b',
      [cellKey('r1', 'cnew1')]: 'c',
    });
    expect(planned.cellW).toBe(200);
  });

  it('rejects anything but exactly one table', () => {
    expect(() => parsePlotGridMarkdown('没有表格')).toThrow(/Markdown 表格/);
    expect(() => parsePlotGridMarkdown('| a |\n| --- |\n| b |')).toThrow(/至少要有一列/);
  });
});
