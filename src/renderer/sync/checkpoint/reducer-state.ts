import { and, asc, count, desc, eq, getTableColumns, gt, inArray, lte, ne, or } from 'drizzle-orm';

import type { DbExecutor, DbTransaction } from '../../lib/db';
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
import {
  compareUtf8Bytewise,
  decodeSyncChangeSetV1,
  type CanonicalCborValue,
  type Hlc,
} from '../protocol';
import {
  canonicalReducerSnapshot,
  describeReducerProfile,
  encodeReducerStatePagesV2,
  installRestoredSqliteReducerStateInTransaction,
  LOCAL_SQLITE_REDUCER_PROFILE,
  loadSqliteReducerStateInTransaction,
  productionSyncDomainMaterializationKernel,
  readSqliteReducerBaseInTransaction,
  reducerLaneKey,
  reducerReceiptSignature,
  sqliteReplayReducerProfile,
  type CanonicalReducerState,
  type ReducerSnapshot,
  type ReducerStateHeaderV2,
  type ReducerStateJournalV2,
  type ReducerSyncGenerationIdentity,
} from '../reducer';
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
  const mutations = await mutationsOf(tx, ids);
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

/** Keep `IN (...)` lists far below SQLite's bind-parameter limit. */
const ID_BATCH = 500;

async function mutationsOf(tx: DbExecutor, changeSetIds: readonly string[]) {
  const rows: (typeof SyncMutationTable.$inferSelect)[] = [];
  for (let offset = 0; offset < changeSetIds.length; offset += ID_BATCH) {
    for (const row of await tx
      .select()
      .from(SyncMutationTable)
      .where(inArray(SyncMutationTable.changeSetId, changeSetIds.slice(offset, offset + ID_BATCH)))) {
      rows.push(row);
    }
  }
  return rows.sort((left, right) =>
    compareUtf8Bytewise(left.changeSetId, right.changeSetId) || left.mutationIndex - right.mutationIndex,
  );
}

/** Change-sets whose mutations the state's registers name as their source. */
function sourceChangeSetIds(snapshot: ReducerSnapshot): Set<string> {
  const ids = new Set<string>();
  const add = (value: { source: { changeSetId: string } } | null) => {
    if (value) ids.add(value.source.changeSetId);
  };
  add(snapshot.generationPurge);
  for (const register of [...snapshot.fields, ...snapshot.tuples, ...snapshot.orders, ...snapshot.assetBindings]) add(register);
  for (const set of snapshot.sets) {
    for (const member of set.members) {
      for (const value of [...member.adds, ...member.removedAddTags]) add(value);
    }
  }
  for (const lifecycle of snapshot.lifecycles) {
    for (const value of [...lifecycle.seeds, ...lifecycle.trashes]) add(value);
    add(lifecycle.purge);
  }
  return ids;
}

export interface CompactedReducerStateCaptureV2 {
  readonly pages: readonly Uint8Array[];
  readonly maxChangeSetHlc: Hlc;
}

/**
 * Captures the compacted canonical reducer state for a payload v2 checkpoint.
 * Coverage is the applied frontier: every change-set it covers is applied,
 * contiguously, above any restored base. Applied change-sets beyond it keep
 * explicit receipts. Only change-sets named as a register source or as an
 * explicit receipt are carried, with their mutations and receipts.
 */
export async function captureCompactedReducerStateV2(
  tx: DbTransaction,
  identity: ReducerSyncGenerationIdentity,
): Promise<CompactedReducerStateCaptureV2> {
  const profile = sqliteReplayReducerProfile(LOCAL_SQLITE_REDUCER_PROFILE, productionSyncDomainMaterializationKernel);
  const { state } = await loadSqliteReducerStateInTransaction(tx, identity, profile, '');
  const base = await readSqliteReducerBaseInTransaction(tx, identity);
  const generation = eq(SyncChangeSetTable.syncGenerationId, identity.syncGenerationId);
  const applied = and(
    eq(SyncApplyReceiptTable.changeSetId, SyncChangeSetTable.changeSetId),
    eq(SyncApplyReceiptTable.syncGenerationId, SyncChangeSetTable.syncGenerationId),
  );

  const frontierRows = await tx
    .select()
    .from(SyncFrontierTable)
    .where(eq(SyncFrontierTable.syncGenerationId, identity.syncGenerationId))
    .orderBy(asc(SyncFrontierTable.writerId), asc(SyncFrontierTable.writerEpoch));
  const coverage = frontierRows
    .filter((row) => row.appliedSeq > 0)
    .map((row) => ({ writerId: row.writerId, writerEpoch: row.writerEpoch, deviceSeq: row.appliedSeq }));
  for (const lane of coverage) {
    const floor = base?.state.coverage.get(reducerLaneKey(lane.writerId, lane.writerEpoch)) ?? 0;
    if (lane.deviceSeq < floor) {
      throw new Error(`applied frontier of ${lane.writerId} is behind the restored reducer base`);
    }
    const [found] = await tx
      .select({ value: count() })
      .from(SyncChangeSetTable)
      .innerJoin(SyncApplyReceiptTable, applied)
      .where(and(
        generation,
        eq(SyncChangeSetTable.writerId, lane.writerId),
        eq(SyncChangeSetTable.writerEpoch, lane.writerEpoch),
        gt(SyncChangeSetTable.deviceSeq, floor),
        lte(SyncChangeSetTable.deviceSeq, lane.deviceSeq),
      ));
    if (Number(found?.value ?? 0) !== lane.deviceSeq - floor) {
      throw new Error(`applied frontier of ${lane.writerId} is not contiguous`);
    }
  }

  const explicitIds: string[] = [];
  const collect = (rows: readonly { changeSetId: string }[]) => {
    for (const row of rows) explicitIds.push(row.changeSetId);
  };
  for (const lane of coverage) {
    collect(await tx
      .select({ changeSetId: SyncChangeSetTable.changeSetId })
      .from(SyncChangeSetTable)
      .innerJoin(SyncApplyReceiptTable, applied)
      .where(and(
        generation,
        eq(SyncChangeSetTable.writerId, lane.writerId),
        eq(SyncChangeSetTable.writerEpoch, lane.writerEpoch),
        gt(SyncChangeSetTable.deviceSeq, lane.deviceSeq),
      )));
  }
  collect(await tx
    .select({ changeSetId: SyncChangeSetTable.changeSetId })
    .from(SyncChangeSetTable)
    .innerJoin(SyncApplyReceiptTable, applied)
    .where(and(
      generation,
      ...coverage.map((lane) => or(
        ne(SyncChangeSetTable.writerId, lane.writerId),
        ne(SyncChangeSetTable.writerEpoch, lane.writerEpoch),
      )),
    )));

  const snapshot = canonicalReducerSnapshot(state);
  const shippedIds = [...new Set([...sourceChangeSetIds(snapshot), ...explicitIds])].sort(compareUtf8Bytewise);
  const changeSetRows: (typeof SyncChangeSetTable.$inferSelect)[] = [];
  const receiptRows: (typeof SyncApplyReceiptTable.$inferSelect)[] = [];
  for (let offset = 0; offset < shippedIds.length; offset += ID_BATCH) {
    const batch = shippedIds.slice(offset, offset + ID_BATCH);
    for (const row of await tx.select().from(SyncChangeSetTable).where(and(generation, inArray(SyncChangeSetTable.changeSetId, batch)))) {
      changeSetRows.push(row);
    }
    for (const row of await tx.select().from(SyncApplyReceiptTable).where(and(
      eq(SyncApplyReceiptTable.syncGenerationId, identity.syncGenerationId),
      inArray(SyncApplyReceiptTable.changeSetId, batch),
    ))) {
      receiptRows.push(row);
    }
  }
  if (changeSetRows.length !== shippedIds.length || receiptRows.length !== shippedIds.length) {
    throw new Error('a reducer register source or explicit receipt is not an applied change-set');
  }
  changeSetRows.sort((left, right) => compareUtf8Bytewise(left.changeSetId, right.changeSetId));
  receiptRows.sort((left, right) => compareUtf8Bytewise(left.changeSetId, right.changeSetId));

  const explicit = new Set(explicitIds);
  const receipts: { changeSetId: string; signature: string }[] = [];
  for (const row of changeSetRows) {
    if (!explicit.has(row.changeSetId)) continue;
    const decoded = await decodeSyncChangeSetV1(row.encodedBytes as Uint8Array);
    if (!decoded.ok) throw new Error(`stored change-set ${row.changeSetId} failed verification`);
    receipts.push({ changeSetId: row.changeSetId, signature: reducerReceiptSignature(decoded.value) });
  }

  const [latest] = await tx
    .select({ wallMs: SyncChangeSetTable.hlcWallMs, counter: SyncChangeSetTable.hlcCounter })
    .from(SyncChangeSetTable)
    .innerJoin(SyncApplyReceiptTable, applied)
    .where(generation)
    .orderBy(desc(SyncChangeSetTable.hlcWallMs), desc(SyncChangeSetTable.hlcCounter))
    .limit(1);
  let maxChangeSetHlc: Hlc = latest ? { wallMs: latest.wallMs, counter: latest.counter } : { wallMs: 0, counter: 0 };
  const baseHlc = base?.header.maxChangeSetHlc;
  if (baseHlc && (baseHlc.wallMs > maxChangeSetHlc.wallMs ||
    (baseHlc.wallMs === maxChangeSetHlc.wallMs && baseHlc.counter > maxChangeSetHlc.counter))) {
    maxChangeSetHlc = baseHlc;
  }

  const pages = encodeReducerStatePagesV2({
    header: { identity, profile: describeReducerProfile(profile), maxChangeSetHlc },
    snapshot: { ...snapshot, coverage, receipts },
    journal: {
      changeSets: serializeRows(SyncChangeSetTable, changeSetRows),
      mutations: serializeRows(SyncMutationTable, await mutationsOf(tx, shippedIds)),
      applyReceipts: serializeRows(SyncApplyReceiptTable, receiptRows),
      frontier: serializeRows(SyncFrontierTable, frontierRows),
    },
  });
  return { pages, maxChangeSetHlc };
}

/**
 * Restores a verified payload v2 reducer section: the carried journal rows as
 * remote ancestry, the frontier, every implied metadata row and the base.
 */
export async function materializeReducerStateV2(
  tx: DbTransaction,
  input: {
    readonly reducer: {
      readonly header: ReducerStateHeaderV2;
      readonly state: CanonicalReducerState;
      readonly journal: ReducerStateJournalV2;
      readonly pages: readonly Uint8Array[];
    };
    readonly sourceCheckpointId: string;
    readonly nowIso: string;
  },
): Promise<void> {
  const { journal } = input.reducer;
  const changeSets = (
    inflateRows(SyncChangeSetTable, journal.changeSets) as (typeof SyncChangeSetTable.$inferInsert)[]
  ).map((row) => ({ ...row, origin: 'remote' as const }));
  const mutations = inflateRows(SyncMutationTable, journal.mutations) as (typeof SyncMutationTable.$inferInsert)[];
  const receipts = inflateRows(SyncApplyReceiptTable, journal.applyReceipts) as (typeof SyncApplyReceiptTable.$inferInsert)[];
  const frontier = inflateRows(SyncFrontierTable, journal.frontier) as (typeof SyncFrontierTable.$inferInsert)[];
  for (const batch of batches(changeSets)) await tx.insert(SyncChangeSetTable).values(batch);
  for (const batch of batches(mutations)) await tx.insert(SyncMutationTable).values(batch);
  for (const batch of batches(receipts)) await tx.insert(SyncApplyReceiptTable).values(batch);
  for (const batch of batches(frontier)) await tx.insert(SyncFrontierTable).values(batch);
  await installRestoredSqliteReducerStateInTransaction(tx, {
    state: input.reducer.state,
    profile: input.reducer.header.profile,
    pages: input.reducer.pages,
    sourceCheckpointId: input.sourceCheckpointId,
    nowIso: input.nowIso,
  });
}
