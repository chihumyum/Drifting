import { and, eq } from 'drizzle-orm';

import type { NodeContent } from '../domain/node-content';
import type { PlotGridMutation } from '../domain/plot-grid';
import type { DbTransaction } from '../lib/db';
import { BookNodeTable } from '../schema/drizzle';
import { createBookContentRepository } from '../sqlite-repo/content-repo';
import { createPlotGridRepository } from '../sqlite-repo/plot-grid-repo';
import {
  appendPlotGridCellPurgeMutation,
  appendPlotGridCellValueSetMutation,
  appendPlotGridColumnCreateMutation,
  appendPlotGridColumnLabelSetMutation,
  appendPlotGridColumnMoveMutation,
  appendPlotGridColumnPurgeMutation,
  appendPlotGridRowCreateMutation,
  appendPlotGridRowLabelSetMutation,
  appendPlotGridRowMoveMutation,
  appendPlotGridRowPurgeMutation,
  appendPlotGridSizeSetMutation,
  runAuthoredTransaction,
  type SyncChangeBuilder,
} from '../sync/journal';

export interface ApplyPlotGridMutationsInput {
  readonly projectId: string;
  readonly nodeId: string;
  readonly mutations: readonly PlotGridMutation[];
}

/**
 * Transaction-owned normalized writer shared by the renderer hook and future
 * typed remote materializer. It never accepts plotGridJson as input.
 */
export async function applyPlotGridMutationsInTransaction(
  tx: DbTransaction,
  changes: SyncChangeBuilder,
  input: ApplyPlotGridMutationsInput,
): Promise<NodeContent> {
  if (input.mutations.length === 0) {
    throw new Error('Plot Grid authored write requires at least one named mutation');
  }
  const node = await tx
    .select({ id: BookNodeTable.id })
    .from(BookNodeTable)
    .where(
      and(
        eq(BookNodeTable.id, input.nodeId),
        eq(BookNodeTable.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!node[0]) {
    throw new Error(`Plot Grid node ${input.nodeId} does not belong to ${input.projectId}`);
  }

  const contentRepo = createBookContentRepository(tx);
  const gridRepo = createPlotGridRepository(tx);
  if (!(await contentRepo.findByNodeId(input.nodeId))) {
    await contentRepo.create({ nodeId: input.nodeId });
  }

  for (const mutation of input.mutations) {
    switch (mutation.type) {
      case 'size.set': {
        const document = await gridRepo.setSize(
          input.nodeId,
          mutation.cellW,
          mutation.cellH,
        );
        appendPlotGridSizeSetMutation(changes, input.nodeId, document);
        break;
      }
      case 'row.add': {
        const row = await gridRepo.addRow(input.nodeId, {
          id: mutation.row.id,
          label: mutation.row.label,
          afterRowId: mutation.afterRowId,
        });
        appendPlotGridRowCreateMutation(changes, row);
        break;
      }
      case 'row.label.set': {
        const row = await gridRepo.setRowLabel(
          input.nodeId,
          mutation.rowId,
          mutation.label,
        );
        appendPlotGridRowLabelSetMutation(changes, row);
        break;
      }
      case 'row.move': {
        const row = await gridRepo.moveRow(input.nodeId, mutation.rowId, mutation.afterRowId);
        appendPlotGridRowMoveMutation(changes, row);
        break;
      }
      case 'row.remove': {
        const removed = await gridRepo.removeRow(input.nodeId, mutation.rowId);
        for (const cell of removed.cells) appendPlotGridCellPurgeMutation(changes, cell.id);
        appendPlotGridRowPurgeMutation(changes, removed.row.id);
        break;
      }
      case 'column.add': {
        const column = await gridRepo.addColumn(input.nodeId, {
          id: mutation.column.id,
          label: mutation.column.label,
          afterColumnId: mutation.afterColumnId,
        });
        appendPlotGridColumnCreateMutation(changes, column);
        break;
      }
      case 'column.label.set': {
        const column = await gridRepo.setColumnLabel(
          input.nodeId,
          mutation.columnId,
          mutation.label,
        );
        appendPlotGridColumnLabelSetMutation(changes, column);
        break;
      }
      case 'column.move': {
        const column = await gridRepo.moveColumn(
          input.nodeId,
          mutation.columnId,
          mutation.afterColumnId,
        );
        appendPlotGridColumnMoveMutation(changes, column);
        break;
      }
      case 'column.remove': {
        const removed = await gridRepo.removeColumn(input.nodeId, mutation.columnId);
        for (const cell of removed.cells) appendPlotGridCellPurgeMutation(changes, cell.id);
        appendPlotGridColumnPurgeMutation(changes, removed.column.id);
        break;
      }
      case 'cell.value.set': {
        const result = await gridRepo.setCellValue(
          input.nodeId,
          mutation.rowId,
          mutation.columnId,
          mutation.value,
        );
        appendPlotGridCellValueSetMutation(changes, result.cell, result.created);
        break;
      }
    }
  }

  const plotGridJson = await gridRepo.materializeProjection(input.nodeId);
  if (!plotGridJson) throw new Error(`Plot Grid ${input.nodeId} lost its normalized document`);
  const updated = await contentRepo.materializePlotGridProjection(input.nodeId, plotGridJson);
  if (!updated) throw new Error(`Plot Grid ${input.nodeId} lost its node content projection`);
  return updated;
}

export function persistPlotGridMutations(input: ApplyPlotGridMutationsInput): Promise<NodeContent> {
  return runAuthoredTransaction(
    input.projectId,
    'plot-grid.mutate',
    ({ tx, changes }) => applyPlotGridMutationsInTransaction(tx, changes, input),
  );
}
