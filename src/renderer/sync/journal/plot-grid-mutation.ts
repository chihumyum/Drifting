import type { SyncChangeBuilder } from './change-builder';

interface PlotGridDocumentMutationRecord {
  readonly cellW: number;
  readonly cellH: number;
}

interface PlotGridAxisMutationRecord {
  readonly id: string;
  readonly documentId: string;
  readonly positionKey: string;
  readonly label: string;
}

interface PlotGridCellMutationRecord {
  readonly id: string;
  readonly documentId: string;
  readonly rowId: string;
  readonly columnId: string;
  readonly value: string;
}

const target = (kind: string, id: string) => ({
  family: 'entity' as const,
  kind,
  id,
  incarnation: 0,
});

export function appendPlotGridSizeSetMutation(
  changes: SyncChangeBuilder,
  nodeId: string,
  document: PlotGridDocumentMutationRecord,
): void {
  changes.add({
    action: 'tuple.set',
    target: target('node-content', nodeId),
    payload: {
      tuple: 'plot-grid-size',
      value: { cellH: document.cellH, cellW: document.cellW },
    },
  });
}

export function appendPlotGridRowCreateMutation(
  changes: SyncChangeBuilder,
  row: PlotGridAxisMutationRecord,
): void {
  changes.add({
    action: 'entity.create',
    target: target('plot-grid-row', row.id),
    payload: { seed: { documentId: row.documentId } },
  });
  appendPlotGridRowLabelSetMutation(changes, row);
  changes.add({
    action: 'order.move',
    target: { family: 'order', kind: 'plot-grid-row', id: row.id, incarnation: 0 },
    payload: { scope: row.documentId, positionKey: row.positionKey },
  });
}

export function appendPlotGridRowLabelSetMutation(
  changes: SyncChangeBuilder,
  row: Pick<PlotGridAxisMutationRecord, 'id' | 'label'>,
): void {
  changes.add({
    action: 'field.set',
    target: target('plot-grid-row', row.id),
    payload: { field: 'label', value: row.label },
  });
}

export function appendPlotGridRowPurgeMutation(
  changes: SyncChangeBuilder,
  rowId: string,
): void {
  changes.add({
    action: 'entity.purge',
    target: target('plot-grid-row', rowId),
    payload: {},
  });
}

export function appendPlotGridColumnCreateMutation(
  changes: SyncChangeBuilder,
  column: PlotGridAxisMutationRecord,
): void {
  changes.add({
    action: 'entity.create',
    target: target('plot-grid-column', column.id),
    payload: { seed: { documentId: column.documentId } },
  });
  appendPlotGridColumnLabelSetMutation(changes, column);
  changes.add({
    action: 'order.move',
    target: {
      family: 'order',
      kind: 'plot-grid-column',
      id: column.id,
      incarnation: 0,
    },
    payload: { scope: column.documentId, positionKey: column.positionKey },
  });
}

export function appendPlotGridColumnLabelSetMutation(
  changes: SyncChangeBuilder,
  column: Pick<PlotGridAxisMutationRecord, 'id' | 'label'>,
): void {
  changes.add({
    action: 'field.set',
    target: target('plot-grid-column', column.id),
    payload: { field: 'label', value: column.label },
  });
}

export function appendPlotGridColumnPurgeMutation(
  changes: SyncChangeBuilder,
  columnId: string,
): void {
  changes.add({
    action: 'entity.purge',
    target: target('plot-grid-column', columnId),
    payload: {},
  });
}

export function appendPlotGridCellValueSetMutation(
  changes: SyncChangeBuilder,
  cell: PlotGridCellMutationRecord,
  created: boolean,
): void {
  if (created) {
    changes.add({
      action: 'entity.create',
      target: target('plot-grid-cell', cell.id),
      payload: {
        seed: {
          columnId: cell.columnId,
          documentId: cell.documentId,
          rowId: cell.rowId,
        },
      },
    });
  }
  changes.add({
    action: 'field.set',
    target: target('plot-grid-cell', cell.id),
    payload: { field: 'value', value: cell.value },
  });
}

export function appendPlotGridCellPurgeMutation(
  changes: SyncChangeBuilder,
  cellId: string,
): void {
  changes.add({
    action: 'entity.purge',
    target: target('plot-grid-cell', cellId),
    payload: {},
  });
}
