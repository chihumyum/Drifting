import { and, eq } from 'drizzle-orm';

import {
  DEFAULT_CELL_H,
  DEFAULT_CELL_W,
  cellKey,
  diffPlotGrid,
  newAxisId,
  readPlotGridProjection,
  type PlotGrid,
} from '../../../domain/plot-grid';
import type { DbExecutor, DbTransaction } from '../../../lib/db';
import { eventBus } from '../../events';
import { BookNodeTable } from '../../../schema/drizzle';
import { createPlotGridRepository } from '../../../sqlite-repo/plot-grid-repo';
import { useDataStore } from '../../../store/data-store';
import { applyPlotGridMutationsInTransaction } from '../../../usecase/plot-grid-write';
import { parsePlotGridMarkdown, planPlotGrid, type PlotGridTable } from '../plot-grid-markdown';
import {
  WorkbenchNoChangeError,
  requiredText,
  sameAuthoredName,
  type WorkbenchCommand,
  type WorkbenchScope,
} from './drifting-workbench-types';

/**
 * One chapter's (or idea's) plot grid as a scope. The grid stays the
 * author's free-form scratchpad — rows and columns mean whatever the author
 * says — and is never injected into Agent context; the Agent reads it with
 * read_plot_grid and writes it as one Markdown table.
 *
 * The image is the grid as the author sees it — labels, cells and order —
 * without axis ids. Applying an image lays it over the stored grid the same
 * way a write does (unchanged labels keep their axis), so a reject recreates
 * removed rows under fresh ids (sync never revives a purged one) and later
 * rejects still match exactly.
 */
export interface PlotGridImage extends PlotGridTable {
  cellW: number;
  cellH: number;
}

export interface PlotGridState {
  grid: PlotGridImage | null;
}

function imageOf(grid: PlotGrid): PlotGridImage {
  return {
    columns: grid.cols.map((column) => column.label),
    rows: grid.rows.map((row) => ({
      label: row.label,
      cells: grid.cols.map((column) => grid.cells[cellKey(row.id, column.id)] ?? ''),
    })),
    cellW: grid.cellW,
    cellH: grid.cellH,
  };
}

async function storedGrid(db: DbExecutor, projectId: string, nodeId: string): Promise<PlotGrid | null> {
  const node = await db
    .select({ id: BookNodeTable.id })
    .from(BookNodeTable)
    .where(and(eq(BookNodeTable.id, nodeId), eq(BookNodeTable.projectId, projectId)))
    .limit(1);
  if (!node[0]) throw new Error('该章节已不存在');
  return readPlotGridProjection(await createPlotGridRepository(db).materializeProjection(nodeId));
}

export const PLOT_GRID_SCOPE: WorkbenchScope<PlotGridState> = {
  kind: 'plot_grid',
  readTool: 'read_plot_grid',
  readArguments: (scopeId) => ({ chapter: scopeId }),
  async load(db, projectId, nodeId) {
    const grid = await storedGrid(db, projectId, nodeId);
    return { grid: grid ? imageOf(grid) : null };
  },
  async apply(tx, input) {
    if (!input.to.grid) throw new Error('情节表不能被删除，只能清空');
    const current = await storedGrid(tx, input.projectId, input.scopeId);
    const target: PlotGrid = {
      ...planPlotGrid(current, input.to.grid, newAxisId),
      cellW: input.to.grid.cellW,
      cellH: input.to.grid.cellH,
    };
    const mutations = diffPlotGrid(current, target);
    if (mutations.length === 0) return;
    await applyPlotGridMutationsInTransaction(tx as DbTransaction, input.changes, {
      projectId: input.projectId,
      nodeId: input.scopeId,
      mutations,
    });
  },
  async project(projectId, nodeId) {
    eventBus.emit('plot-grid:changed', { projectId, nodeId });
  },
};

/** The chapter or idea a plot grid belongs to, by name or id. */
export function resolvePlotGridNode(projectId: string, value: unknown): { id: string; title: string } {
  const reference = requiredText(value, 'chapter');
  const nodes = useDataStore.getState().bookNodes.filter((node) => node.projectId === projectId);
  const direct = nodes.find((node) => node.id === reference);
  if (direct) return direct;
  const chapters = nodes.filter((node) => node.kind === 'chapter' && sameAuthoredName(node.title, reference));
  const matches = chapters.length > 0 ? chapters : nodes.filter((node) => sameAuthoredName(node.title, reference));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`有 ${matches.length} 个章节或构想都叫「${reference}」`);
  throw new Error(`没有名为「${reference}」的章节或构想`);
}

function sameImage(left: PlotGridImage | null, right: PlotGridImage): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}

function nextImage(state: PlotGridState, table: PlotGridTable): PlotGridImage {
  return {
    columns: table.columns,
    rows: table.rows,
    cellW: state.grid?.cellW ?? DEFAULT_CELL_W,
    cellH: state.grid?.cellH ?? DEFAULT_CELL_H,
  };
}

interface PlotGridExtra {
  /** The grid did not exist before: a reject leaves this shape, emptied. */
  created: PlotGridImage | null;
}

const writePlotGrid: WorkbenchCommand<PlotGridState> = {
  name: 'write_plot_grid',
  scope: PLOT_GRID_SCOPE,
  scopeId: (projectId, args) =>
    typeof args.nodeId === 'string' && args.nodeId ? args.nodeId : resolvePlotGridNode(projectId, args.chapter).id,
  resolve(state, args, projectId) {
    const node = resolvePlotGridNode(projectId, args.chapter);
    const table = parsePlotGridMarkdown(requiredText(args.table, 'table'));
    if (sameImage(state.grid, nextImage(state, table))) {
      throw new WorkbenchNoChangeError(`「${node.title}」的情节表`);
    }
    return {
      arguments: { nodeId: node.id, table: args.table },
      path: `/chapters/${node.title}/plot-grid.md`,
      changeSummary: `${state.grid ? '更新' : '新建'}「${node.title}」的情节表（${table.rows.length} 行 × ${table.columns.length} 列）`,
    };
  },
  async plan(state, args) {
    const next = nextImage(state, parsePlotGridMarkdown(requiredText(args.table, 'table')));
    if (sameImage(state.grid, next)) throw new WorkbenchNoChangeError('情节表');
    return { next: { grid: next }, extra: { created: state.grid ? null : next } satisfies PlotGridExtra };
  },
  inverseImage(before, extra) {
    if (before.grid) return before;
    // There is no "no grid" mutation: rejecting the first write leaves the
    // same rows and columns with every label and cell cleared.
    const created = (extra as PlotGridExtra).created!;
    return {
      grid: {
        ...created,
        columns: created.columns.map(() => ''),
        rows: created.rows.map((row) => ({ label: '', cells: row.cells.map(() => '') })),
      },
    };
  },
};

export const PLOT_GRID_COMMANDS = [writePlotGrid] as const;
