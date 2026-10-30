import { marked, type Tokens } from 'marked';

import {
  DEFAULT_CELL_H,
  DEFAULT_CELL_W,
  cellKey,
  type PlotAxis,
  type PlotGrid,
} from '../../domain/plot-grid';

/**
 * A plot grid as the Agent reads and writes it: one Markdown table whose
 * header row holds the column labels (after an empty corner cell) and whose
 * first column holds the row labels. Line breaks inside a cell are `<br>`.
 */
export interface PlotGridTable {
  columns: string[];
  rows: Array<{ label: string; cells: string[] }>;
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>').trim();
}

function unescapeCell(value: string): string {
  return value.replace(/<br\s*\/?\s*>/giu, '\n').replace(/\\\|/gu, '|').trim();
}

export function plotGridToMarkdown(grid: PlotGrid): string {
  const line = (cells: readonly string[]) => `| ${cells.map(escapeCell).join(' | ')} |`;
  return [
    line(['', ...grid.cols.map((column) => column.label)]),
    line(['---', ...grid.cols.map(() => '---')]),
    ...grid.rows.map((row) =>
      line([row.label, ...grid.cols.map((column) => grid.cells[cellKey(row.id, column.id)] ?? '')]),
    ),
  ].join('\n');
}

export function parsePlotGridMarkdown(markdown: string): PlotGridTable {
  const tokens = marked.lexer(markdown.replace(/\r\n?/gu, '\n').trim(), { gfm: true });
  const tables = tokens.filter((token): token is Tokens.Table => token.type === 'table');
  if (tables.length !== 1) throw new Error('table 必须正好是一张 Markdown 表格');
  const table = tables[0]!;
  const columns = table.header.slice(1).map((cell) => unescapeCell(cell.text));
  if (columns.length === 0) throw new Error('情节表至少要有一列（表头第一格之后）');
  const rows = table.rows.map((row) => ({
    label: unescapeCell(row[0]?.text ?? ''),
    cells: columns.map((_, index) => unescapeCell(row[index + 1]?.text ?? '')),
  }));
  if (rows.length === 0) throw new Error('情节表至少要有一行');
  return { columns, rows };
}

/**
 * Lay the authored table over the current grid. An axis keeps its identity
 * when its label is unchanged, otherwise by position among the axes left
 * over, so a relabeled row stays the same row; the rest are new.
 */
export function planPlotGrid(
  previous: PlotGrid | null,
  table: PlotGridTable,
  newId: (prefix: 'r' | 'c') => string,
): PlotGrid {
  const match = (existing: readonly PlotAxis[], labels: readonly string[], prefix: 'r' | 'c'): PlotAxis[] => {
    const used = new Set<string>();
    const assigned: Array<PlotAxis | null> = labels.map((label) => {
      if (!label) return null;
      const found = existing.find((axis) => !used.has(axis.id) && axis.label === label);
      if (!found) return null;
      used.add(found.id);
      return { id: found.id, label };
    });
    const leftovers = existing.filter((axis) => !used.has(axis.id));
    return assigned.map((axis, index) => {
      if (axis) return axis;
      const reuse = leftovers.shift();
      return { id: reuse?.id ?? newId(prefix), label: labels[index]! };
    });
  };
  const cols = match(previous?.cols ?? [], table.columns, 'c');
  const rows = match(previous?.rows ?? [], table.rows.map((row) => row.label), 'r');
  const cells: Record<string, string> = {};
  table.rows.forEach((row, rowIndex) => {
    row.cells.forEach((value, columnIndex) => {
      if (value) cells[cellKey(rows[rowIndex]!.id, cols[columnIndex]!.id)] = value;
    });
  });
  return {
    rows,
    cols,
    cells,
    cellW: previous?.cellW ?? DEFAULT_CELL_W,
    cellH: previous?.cellH ?? DEFAULT_CELL_H,
  };
}
