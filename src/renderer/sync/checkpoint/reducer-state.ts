import { and, asc, eq, getTableColumns, inArray } from 'drizzle-orm';

import type { DbExecutor } from '../../lib/db';
import {
  SyncApplyReceiptTable,
  SyncChangeSetTable,
  SyncFieldClockTable,
  SyncFrontierTable,
  SyncMutationTable,
  SyncOrderRegisterTable,
  SyncSetTagTable,
  SyncGenerationPurgeTable,
  SyncEntityLifecycleTable,
} from '../../schema/drizzle';
import type { CanonicalCborValue } from '../protocol';
import {
  REDUCER_STATE_FORMAT_V1,
  type ReducerStatePayloadV1,
} from './types';

type SnapshotRow = Readonly<Record<string, CanonicalCborValue>>;
type TableLike = Parameters<typeof getTableColumns>[0];

function serializeRows(table: TableLike, rows: readonly Readonly<Record<string, unknown>>[]): SnapshotRow[] {
  const columns = getTableColumns(table);
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(columns).map(([property, column]) => {
        const value = row[property];
        if (value === undefined) throw new Error(`${column.name} is missing from reducer capture`);
        return [column.name, value as CanonicalCborValue];
      }),
    ),
  );
}

function inflateRows<TTable extends TableLike>(
  table: TTable,
  rows: readonly SnapshotRow[],
): Readonly<Record<string, unknown>>[] {
  const columns = getTableColumns(table);
  const byName = new Map(Object.entries(columns).map(([property, column]) => [column.name, property]));
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([columnName, value]) => {
        const property = byName.get(columnName);
        if (!property) throw new Error(`Reducer snapshot contains unknown column ${columnName}`);
        return [property, value];
      }),
    ),
  );
}

export async function captureReducerStateV1(
  tx: DbExecutor,
  syncGenerationId: string,
): Promise<ReducerStatePayloadV1> {
  const [changeSets, receipts, generationPurges, fieldClocks, setTags, orderRegisters, lifecycles, frontier] =
    await Promise.all([
      tx
        .select()
        .from(SyncChangeSetTable)
        .where(and(eq(SyncChangeSetTable.syncGenerationId, syncGenerationId), eq(SyncChangeSetTable.applyState, 'applied')))
        .orderBy(
          asc(SyncChangeSetTable.writerId),
          asc(SyncChangeSetTable.writerEpoch),
          asc(SyncChangeSetTable.deviceSeq),
        ),
      tx
        .select()
        .from(SyncApplyReceiptTable)
        .where(eq(SyncApplyReceiptTable.syncGenerationId, syncGenerationId))
        .orderBy(asc(SyncApplyReceiptTable.changeSetId)),
      tx
        .select()
        .from(SyncGenerationPurgeTable)
        .where(eq(SyncGenerationPurgeTable.syncGenerationId, syncGenerationId)),
      tx
        .select()
        .from(SyncFieldClockTable)
        .where(eq(SyncFieldClockTable.syncGenerationId, syncGenerationId))
        .orderBy(
          asc(SyncFieldClockTable.targetKind),
          asc(SyncFieldClockTable.targetId),
          asc(SyncFieldClockTable.incarnation),
          asc(SyncFieldClockTable.fieldKey),
        ),
      tx
        .select()
        .from(SyncSetTagTable)
        .where(eq(SyncSetTagTable.syncGenerationId, syncGenerationId))
        .orderBy(
          asc(SyncSetTagTable.ownerKind),
          asc(SyncSetTagTable.ownerId),
          asc(SyncSetTagTable.setKey),
          asc(SyncSetTagTable.valueKey),
          asc(SyncSetTagTable.addTag),
        ),
      tx
        .select()
        .from(SyncOrderRegisterTable)
        .where(eq(SyncOrderRegisterTable.syncGenerationId, syncGenerationId))
        .orderBy(
          asc(SyncOrderRegisterTable.listKind),
          asc(SyncOrderRegisterTable.ownerId),
          asc(SyncOrderRegisterTable.positionKey),
          asc(SyncOrderRegisterTable.entityId),
        ),
      tx
        .select()
        .from(SyncEntityLifecycleTable)
        .where(eq(SyncEntityLifecycleTable.syncGenerationId, syncGenerationId))
        .orderBy(
          asc(SyncEntityLifecycleTable.entityKind),
          asc(SyncEntityLifecycleTable.entityId),
        ),
      tx
        .select()
        .from(SyncFrontierTable)
        .where(eq(SyncFrontierTable.syncGenerationId, syncGenerationId))
        .orderBy(asc(SyncFrontierTable.writerId), asc(SyncFrontierTable.writerEpoch)),
    ]);
  const ids = changeSets.map((row) => row.changeSetId);
  const mutations = ids.length === 0
    ? []
    : await tx
        .select()
        .from(SyncMutationTable)
        .where(inArray(SyncMutationTable.changeSetId, ids))
        .orderBy(asc(SyncMutationTable.changeSetId), asc(SyncMutationTable.mutationIndex));
  return {
    format: REDUCER_STATE_FORMAT_V1,
    payloadVersion: 1,
    changeSets: serializeRows(SyncChangeSetTable, changeSets),
    mutations: serializeRows(SyncMutationTable, mutations),
    applyReceipts: serializeRows(SyncApplyReceiptTable, receipts),
    generationPurges: serializeRows(SyncGenerationPurgeTable, generationPurges),
    fieldClocks: serializeRows(SyncFieldClockTable, fieldClocks),
    setTags: serializeRows(SyncSetTagTable, setTags),
    orderRegisters: serializeRows(SyncOrderRegisterTable, orderRegisters),
    lifecycles: serializeRows(SyncEntityLifecycleTable, lifecycles),
    frontier: serializeRows(SyncFrontierTable, frontier),
  };
}

// Keep snapshot restore/rebase below even SQLite's conservative bind limit.
function* batches<T>(rows: readonly T[]): Generator<T[]> {
  for (let offset = 0; offset < rows.length; offset += 32) yield rows.slice(offset, offset + 32);
}

export async function materializeReducerStateV1(
  tx: DbExecutor,
  state: ReducerStatePayloadV1,
): Promise<void> {
  const changeSets = (
    inflateRows(SyncChangeSetTable, state.changeSets) as (typeof SyncChangeSetTable.$inferInsert)[]
  ).map((row) => ({
    ...row,
    // A checkpoint is a state-transfer boundary. Its source journal remains
    // reducer ancestry for clocks/FKs, but it is never this installation's
    // outbound authored lane.
    origin: 'remote' as const,
  }));
  const mutations = inflateRows(SyncMutationTable, state.mutations) as (typeof SyncMutationTable.$inferInsert)[];
  const receipts = inflateRows(SyncApplyReceiptTable, state.applyReceipts) as (typeof SyncApplyReceiptTable.$inferInsert)[];
  const generationPurges = inflateRows(SyncGenerationPurgeTable, state.generationPurges) as (typeof SyncGenerationPurgeTable.$inferInsert)[];
  const fieldClocks = inflateRows(SyncFieldClockTable, state.fieldClocks) as (typeof SyncFieldClockTable.$inferInsert)[];
  const setTags = inflateRows(SyncSetTagTable, state.setTags) as (typeof SyncSetTagTable.$inferInsert)[];
  const orderRegisters = inflateRows(SyncOrderRegisterTable, state.orderRegisters) as (typeof SyncOrderRegisterTable.$inferInsert)[];
  const lifecycles = inflateRows(SyncEntityLifecycleTable, state.lifecycles) as (typeof SyncEntityLifecycleTable.$inferInsert)[];
  const frontier = inflateRows(SyncFrontierTable, state.frontier) as (typeof SyncFrontierTable.$inferInsert)[];
  for (const batch of batches(changeSets)) await tx.insert(SyncChangeSetTable).values(batch);
  for (const batch of batches(mutations)) await tx.insert(SyncMutationTable).values(batch);
  for (const batch of batches(receipts)) await tx.insert(SyncApplyReceiptTable).values(batch);
  for (const batch of batches(generationPurges)) await tx.insert(SyncGenerationPurgeTable).values(batch);
  for (const batch of batches(fieldClocks)) await tx.insert(SyncFieldClockTable).values(batch);
  for (const batch of batches(setTags)) await tx.insert(SyncSetTagTable).values(batch);
  for (const batch of batches(orderRegisters)) await tx.insert(SyncOrderRegisterTable).values(batch);
  for (const batch of batches(lifecycles)) await tx.insert(SyncEntityLifecycleTable).values(batch);
  for (const batch of batches(frontier)) await tx.insert(SyncFrontierTable).values(batch);
}
