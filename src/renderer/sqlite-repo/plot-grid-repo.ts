import { and, asc, eq } from 'drizzle-orm';

import {
  DEFAULT_CELL_H,
  DEFAULT_CELL_W,
  MAX_CELL_H,
  MAX_CELL_W,
  MIN_CELL_H,
  MIN_CELL_W,
  cellKey,
  serializePlotGrid,
  type PlotGrid,
} from '../domain/plot-grid';
import { getDb, type DbExecutor } from '../lib/db';
import {
  PlotGridCellTable,
  PlotGridColumnTable,
  PlotGridDocumentTable,
  PlotGridRowTable,
} from '../schema/drizzle';
import { fractionalPositionKeyBetween } from '../sync/journal/order-authority';

export interface PlotGridDocumentRecord {
  readonly id: string;
  readonly nodeId: string;
  readonly cellW: number;
  readonly cellH: number;
}

export interface PlotGridAxisRecord {
  readonly id: string;
  readonly documentId: string;
  readonly positionKey: string;
  readonly label: string;
}

export interface PlotGridCellRecord {
  readonly id: string;
  readonly documentId: string;
  readonly rowId: string;
  readonly columnId: string;
  readonly value: string;
}

export interface PlotGridAuthority {
  readonly document: PlotGridDocumentRecord;
  readonly rows: readonly PlotGridAxisRecord[];
  readonly columns: readonly PlotGridAxisRecord[];
  readonly cells: readonly PlotGridCellRecord[];
}

export interface PlotGridRepository {
  findAuthorityByNodeId(nodeId: string): Promise<PlotGridAuthority | null>;
  ensureDocument(nodeId: string): Promise<PlotGridDocumentRecord>;
  setSize(nodeId: string, cellW: number, cellH: number): Promise<PlotGridDocumentRecord>;
  addRow(
    nodeId: string,
    input: { id: string; label: string; afterRowId: string | null },
  ): Promise<PlotGridAxisRecord>;
  setRowLabel(nodeId: string, rowId: string, label: string): Promise<PlotGridAxisRecord>;
  removeRow(
    nodeId: string,
    rowId: string,
  ): Promise<{ row: PlotGridAxisRecord; cells: readonly PlotGridCellRecord[] }>;
  addColumn(
    nodeId: string,
    input: { id: string; label: string; afterColumnId: string | null },
  ): Promise<PlotGridAxisRecord>;
  setColumnLabel(
    nodeId: string,
    columnId: string,
    label: string,
  ): Promise<PlotGridAxisRecord>;
  removeColumn(
    nodeId: string,
    columnId: string,
  ): Promise<{ column: PlotGridAxisRecord; cells: readonly PlotGridCellRecord[] }>;
  setCellValue(
    nodeId: string,
    rowId: string,
    columnId: string,
    value: string,
  ): Promise<{ cell: PlotGridCellRecord; created: boolean }>;
  materializeProjection(nodeId: string): Promise<string | null>;
}

export function plotGridDocumentId(nodeId: string): string {
  if (nodeId.length === 0) throw new TypeError('Plot Grid nodeId is required');
  return `plot-grid:${nodeId}`;
}

/** One coordinate has one identity on every device, including concurrent first edits. */
export function plotGridCellId(
  documentId: string,
  rowId: string,
  columnId: string,
): string {
  if (documentId.length === 0 || rowId.length === 0 || columnId.length === 0) {
    throw new TypeError('Plot Grid cell identity requires documentId, rowId, and columnId');
  }
  return `plot-cell:${documentId.length}:${documentId}${rowId.length}:${rowId}${columnId}`;
}

/**
 * Plot Grid shares the same unbounded fractional-indexing authority as every
 * other discrete list. Equal keys can still arrive from concurrent devices;
 * rendering then uses the stable UTF-8 entity-ID tie-break.
 */
export function plotGridPositionBetween(
  left: string | null,
  right: string | null,
): string {
  return fractionalPositionKeyBetween(left, right);
}

function toDocument(
  record: typeof PlotGridDocumentTable.$inferSelect,
): PlotGridDocumentRecord {
  return {
    id: record.id,
    nodeId: record.nodeId,
    cellW: record.cellWidth,
    cellH: record.cellHeight,
  };
}

function toRow(record: typeof PlotGridRowTable.$inferSelect): PlotGridAxisRecord {
  return {
    id: record.id,
    documentId: record.documentId,
    positionKey: record.positionKey,
    label: record.label,
  };
}

function toColumn(record: typeof PlotGridColumnTable.$inferSelect): PlotGridAxisRecord {
  return {
    id: record.id,
    documentId: record.documentId,
    positionKey: record.positionKey,
    label: record.label,
  };
}

function toCell(record: typeof PlotGridCellTable.$inferSelect): PlotGridCellRecord {
  return {
    id: record.id,
    documentId: record.documentId,
    rowId: record.rowId,
    columnId: record.columnId,
    value: record.value,
  };
}

function assertSize(cellW: number, cellH: number): void {
  if (
    !Number.isFinite(cellW) ||
    !Number.isFinite(cellH) ||
    cellW < MIN_CELL_W ||
    cellW > MAX_CELL_W ||
    cellH < MIN_CELL_H ||
    cellH > MAX_CELL_H
  ) {
    throw new TypeError(`Invalid Plot Grid size tuple: ${cellW}x${cellH}`);
  }
}

export function createPlotGridRepository(dbOverride?: DbExecutor): PlotGridRepository {
  const db = () => dbOverride ?? getDb();

  const findDocument = async (nodeId: string): Promise<PlotGridDocumentRecord | null> => {
    const rows = await db()
      .select()
      .from(PlotGridDocumentTable)
      .where(eq(PlotGridDocumentTable.nodeId, nodeId))
      .limit(1);
    return rows[0] ? toDocument(rows[0]) : null;
  };

  const ensureDocument = async (nodeId: string): Promise<PlotGridDocumentRecord> => {
    const existing = await findDocument(nodeId);
    if (existing) return existing;
    const document = {
      id: plotGridDocumentId(nodeId),
      nodeId,
      cellWidth: DEFAULT_CELL_W,
      cellHeight: DEFAULT_CELL_H,
    } satisfies typeof PlotGridDocumentTable.$inferInsert;
    await db().insert(PlotGridDocumentTable).values(document);
    return toDocument(document as typeof PlotGridDocumentTable.$inferSelect);
  };

  const orderedRows = async (documentId: string): Promise<PlotGridAxisRecord[]> =>
    (
      await db()
        .select()
        .from(PlotGridRowTable)
        .where(eq(PlotGridRowTable.documentId, documentId))
        .orderBy(asc(PlotGridRowTable.positionKey), asc(PlotGridRowTable.id))
    ).map(toRow);

  const orderedColumns = async (documentId: string): Promise<PlotGridAxisRecord[]> =>
    (
      await db()
        .select()
        .from(PlotGridColumnTable)
        .where(eq(PlotGridColumnTable.documentId, documentId))
        .orderBy(asc(PlotGridColumnTable.positionKey), asc(PlotGridColumnTable.id))
    ).map(toColumn);

  const positionAfter = (
    axes: readonly PlotGridAxisRecord[],
    afterId: string | null,
    label: 'row' | 'column',
  ): string => {
    if (afterId === null) {
      return plotGridPositionBetween(null, axes[0]?.positionKey ?? null);
    }
    const index = axes.findIndex(({ id }) => id === afterId);
    if (index < 0) throw new Error(`Plot Grid ${label} ${afterId} does not exist`);
    return plotGridPositionBetween(
      axes[index]!.positionKey,
      axes[index + 1]?.positionKey ?? null,
    );
  };

  const findAuthorityByNodeId = async (
    nodeId: string,
  ): Promise<PlotGridAuthority | null> => {
    const document = await findDocument(nodeId);
    if (!document) return null;
    const [rows, columns, cellRows] = await Promise.all([
      orderedRows(document.id),
      orderedColumns(document.id),
      db()
        .select()
        .from(PlotGridCellTable)
        .where(eq(PlotGridCellTable.documentId, document.id))
        .orderBy(asc(PlotGridCellTable.id)),
    ]);
    return { document, rows, columns, cells: cellRows.map(toCell) };
  };

  const requireDocument = async (nodeId: string): Promise<PlotGridDocumentRecord> =>
    ensureDocument(nodeId);

  const requireRow = async (
    documentId: string,
    rowId: string,
  ): Promise<PlotGridAxisRecord> => {
    const rows = await db()
      .select()
      .from(PlotGridRowTable)
      .where(
        and(
          eq(PlotGridRowTable.id, rowId),
          eq(PlotGridRowTable.documentId, documentId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new Error(`Plot Grid row ${rowId} does not belong to ${documentId}`);
    return toRow(rows[0]);
  };

  const requireColumn = async (
    documentId: string,
    columnId: string,
  ): Promise<PlotGridAxisRecord> => {
    const rows = await db()
      .select()
      .from(PlotGridColumnTable)
      .where(
        and(
          eq(PlotGridColumnTable.id, columnId),
          eq(PlotGridColumnTable.documentId, documentId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw new Error(`Plot Grid column ${columnId} does not belong to ${documentId}`);
    }
    return toColumn(rows[0]);
  };

  return {
    findAuthorityByNodeId,
    ensureDocument,

    async setSize(nodeId, cellW, cellH) {
      assertSize(cellW, cellH);
      const document = await requireDocument(nodeId);
      await db()
        .update(PlotGridDocumentTable)
        .set({ cellWidth: cellW, cellHeight: cellH })
        .where(eq(PlotGridDocumentTable.id, document.id));
      return { ...document, cellW, cellH };
    },

    async addRow(nodeId, input) {
      if (input.id.length === 0) throw new TypeError('Plot Grid row id is required');
      const document = await requireDocument(nodeId);
      const positionKey = positionAfter(
        await orderedRows(document.id),
        input.afterRowId,
        'row',
      );
      const row = {
        id: input.id,
        documentId: document.id,
        positionKey,
        label: input.label,
      } satisfies typeof PlotGridRowTable.$inferInsert;
      await db().insert(PlotGridRowTable).values(row);
      return toRow(row as typeof PlotGridRowTable.$inferSelect);
    },

    async setRowLabel(nodeId, rowId, label) {
      const document = await requireDocument(nodeId);
      const row = await requireRow(document.id, rowId);
      await db()
        .update(PlotGridRowTable)
        .set({ label })
        .where(
          and(eq(PlotGridRowTable.id, rowId), eq(PlotGridRowTable.documentId, document.id)),
        );
      return { ...row, label };
    },

    async removeRow(nodeId, rowId) {
      const document = await requireDocument(nodeId);
      const rows = await orderedRows(document.id);
      if (rows.length <= 1) throw new Error('Plot Grid cannot remove its last row');
      const row = await requireRow(document.id, rowId);
      const cells = (
        await db()
          .select()
          .from(PlotGridCellTable)
          .where(
            and(
              eq(PlotGridCellTable.documentId, document.id),
              eq(PlotGridCellTable.rowId, rowId),
            ),
          )
          .orderBy(asc(PlotGridCellTable.id))
      ).map(toCell);
      await db()
        .delete(PlotGridRowTable)
        .where(
          and(eq(PlotGridRowTable.id, rowId), eq(PlotGridRowTable.documentId, document.id)),
        );
      return { row, cells };
    },

    async addColumn(nodeId, input) {
      if (input.id.length === 0) throw new TypeError('Plot Grid column id is required');
      const document = await requireDocument(nodeId);
      const positionKey = positionAfter(
        await orderedColumns(document.id),
        input.afterColumnId,
        'column',
      );
      const column = {
        id: input.id,
        documentId: document.id,
        positionKey,
        label: input.label,
      } satisfies typeof PlotGridColumnTable.$inferInsert;
      await db().insert(PlotGridColumnTable).values(column);
      return toColumn(column as typeof PlotGridColumnTable.$inferSelect);
    },

    async setColumnLabel(nodeId, columnId, label) {
      const document = await requireDocument(nodeId);
      const column = await requireColumn(document.id, columnId);
      await db()
        .update(PlotGridColumnTable)
        .set({ label })
        .where(
          and(
            eq(PlotGridColumnTable.id, columnId),
            eq(PlotGridColumnTable.documentId, document.id),
          ),
        );
      return { ...column, label };
    },

    async removeColumn(nodeId, columnId) {
      const document = await requireDocument(nodeId);
      const columns = await orderedColumns(document.id);
      if (columns.length <= 1) throw new Error('Plot Grid cannot remove its last column');
      const column = await requireColumn(document.id, columnId);
      const cells = (
        await db()
          .select()
          .from(PlotGridCellTable)
          .where(
            and(
              eq(PlotGridCellTable.documentId, document.id),
              eq(PlotGridCellTable.columnId, columnId),
            ),
          )
          .orderBy(asc(PlotGridCellTable.id))
      ).map(toCell);
      await db()
        .delete(PlotGridColumnTable)
        .where(
          and(
            eq(PlotGridColumnTable.id, columnId),
            eq(PlotGridColumnTable.documentId, document.id),
          ),
        );
      return { column, cells };
    },

    async setCellValue(nodeId, rowId, columnId, value) {
      const document = await requireDocument(nodeId);
      await requireRow(document.id, rowId);
      await requireColumn(document.id, columnId);
      const id = plotGridCellId(document.id, rowId, columnId);
      const existing = await db()
        .select()
        .from(PlotGridCellTable)
        .where(
          and(
            eq(PlotGridCellTable.documentId, document.id),
            eq(PlotGridCellTable.rowId, rowId),
            eq(PlotGridCellTable.columnId, columnId),
          ),
        )
        .limit(1);
      if (existing[0]) {
        await db()
          .update(PlotGridCellTable)
          .set({ value })
          .where(eq(PlotGridCellTable.id, existing[0].id));
        return { cell: { ...toCell(existing[0]), value }, created: false };
      }
      const cell = {
        id,
        documentId: document.id,
        rowId,
        columnId,
        value,
      } satisfies typeof PlotGridCellTable.$inferInsert;
      await db().insert(PlotGridCellTable).values(cell);
      return {
        cell: toCell(cell as typeof PlotGridCellTable.$inferSelect),
        created: true,
      };
    },

    async materializeProjection(nodeId) {
      const authority = await findAuthorityByNodeId(nodeId);
      if (!authority) return null;
      const values = new Map(
        authority.cells.map((cell) => [cellKey(cell.rowId, cell.columnId), cell.value]),
      );
      const cells: Record<string, string> = {};
      for (const row of authority.rows) {
        for (const column of authority.columns) {
          const key = cellKey(row.id, column.id);
          const value = values.get(key);
          if (value) cells[key] = value;
        }
      }
      const grid: PlotGrid = {
        rows: authority.rows.map(({ id, label }) => ({ id, label })),
        cols: authority.columns.map(({ id, label }) => ({ id, label })),
        cells,
        cellW: authority.document.cellW,
        cellH: authority.document.cellH,
      };
      return serializePlotGrid(grid);
    },
  };
}
