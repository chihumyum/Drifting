/**
 * Where canonical reducer state comes from between applies: an in-memory
 * cache, a derived local snapshot, an authoritative base installed by a
 * checkpoint restore, and the receipt-backed journal. A rebuild starts from
 * the newest usable compacted state and replays only the applied change-sets
 * it does not cover, in linear time.
 */
import { and, count, eq, gt, inArray, lte, ne, or, sql } from 'drizzle-orm';

import { beginDevActivity } from '../../lib/dev-activity';
import type { DbExecutor, DbTransaction } from '../../lib/db';
import {
  SyncApplyReceiptTable,
  SyncChangeSetTable,
  SyncReducerBaseTable,
  SyncReducerSnapshotTable,
} from '../../schema/drizzle';
import {
  compareSyncTotalOrder,
  compareUtf8Bytewise,
  decodeCanonicalCbor,
  decodeSyncChangeSetV1,
  encodeCanonicalCbor,
  type SyncChangeSetV1,
} from '../protocol';
import {
  compactReducerReceipts,
  createCanonicalReducerState,
  reducerStateFromSnapshot,
  replaySyncChangeSets,
} from './reducer';
import { decodeReducerState, encodeReducerState, REDUCER_STATE_SNAPSHOT_FORMAT } from './state-snapshot';
import {
  decodeReducerStatePagesV2,
  describeReducerProfile,
  type ReducerStateHeaderV2,
  type ReducerStateProfileV2,
} from './state-pages';
import type {
  CanonicalReducerState,
  ReducerEffect,
  ReducerProfile,
  ReducerSyncGenerationIdentity,
} from './types';

export class SyncReducerRejectedError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(`sync reducer rejected ${code} at ${path}: ${message}`);
    this.name = 'SyncReducerRejectedError';
  }
}

/** A canonical state together with the SQLite journal it accounts for. */
export interface StoredReducerState {
  readonly state: CanonicalReducerState;
  /** Applied receipt rows in SQLite, excluding the change-set being applied. */
  readonly receiptRows: number;
  /** Validated effects last materialized from `state`; null after a rebuild. */
  readonly effects: readonly ReducerEffect[] | null;
}

interface CachedReducerState {
  readonly current: StoredReducerState;
  /** The state before the latest optimistic write, reused if that write rolled back. */
  readonly previous: StoredReducerState | null;
}

const reducerStateCache = new Map<string, CachedReducerState>();
/** Receipt rows covered by the newest persisted snapshot, per cache key. */
const persistedSnapshotRows = new Map<string, number>();

/** Persist a snapshot once this many receipt rows are not yet covered by one. */
const DEFAULT_SNAPSHOT_INTERVAL = 2_000;
let snapshotInterval = DEFAULT_SNAPSHOT_INTERVAL;
/** Keep `IN (...)` lists far below SQLite's bind-parameter limit. */
const ID_BATCH = 500;

export interface SqliteReducerLoadDiagnostics {
  readonly syncGenerationId: string;
  readonly source: 'snapshot' | 'base' | 'journal';
  readonly startReceipts: number;
  readonly replayedChangeSets: number;
  readonly durationMs: number;
}

let lastReducerLoad: SqliteReducerLoadDiagnostics | null = null;

/** How the most recent cache miss rebuilt reducer state; null before the first. */
export function getSqliteReducerLoadDiagnostics(): SqliteReducerLoadDiagnostics | null {
  return lastReducerLoad;
}

/** Tests shorten the snapshot interval; `null` restores the default. */
export function setSqliteReducerSnapshotIntervalForTest(interval: number | null): void {
  snapshotInterval = interval ?? DEFAULT_SNAPSHOT_INTERVAL;
}

const reducerValidatorIds = new WeakMap<NonNullable<ReducerProfile['validateProjection']>, number>();
let nextReducerValidatorId = 1;

export function reducerCacheKey(identity: ReducerSyncGenerationIdentity, profile: ReducerProfile): string {
  const validator = profile.validateProjection;
  let validatorId = 0;
  if (validator) {
    validatorId = reducerValidatorIds.get(validator) ?? nextReducerValidatorId++;
    reducerValidatorIds.set(validator, validatorId);
  }
  return JSON.stringify([
    identity.projectId,
    identity.projectSyncId,
    identity.syncGenerationId,
    [...profile.knownTargetKinds].sort(compareUtf8Bytewise),
    [...(profile.externallyMaterializedActions ?? [])].sort(compareUtf8Bytewise),
    validatorId,
  ]);
}

/** Durable identity of a persisted profile description. */
export function reducerProfileDescriptionKey(description: ReducerStateProfileV2): string {
  return JSON.stringify([description.knownTargetKinds, description.externallyMaterializedActions]);
}

/** Durable identity of a data-only profile; null when it has a projection validator. */
export function persistentReducerProfileKey(profile: ReducerProfile): string | null {
  return profile.validateProjection ? null : reducerProfileDescriptionKey(describeReducerProfile(profile));
}

/** Checkpoint activation/database reset must invalidate the affected SyncGeneration. */
export function invalidateSqliteReducerStateCache(syncGenerationId?: string): void {
  if (syncGenerationId === undefined) {
    reducerStateCache.clear();
    persistedSnapshotRows.clear();
    return;
  }
  for (const [key, cached] of reducerStateCache) {
    if (cached.current.state.identity.syncGenerationId === syncGenerationId) {
      reducerStateCache.delete(key);
      persistedSnapshotRows.delete(key);
    }
  }
}

/**
 * A renderer can briefly run against a database opened by an older native
 * build. Without the tables there is neither a snapshot nor a base.
 */
async function reducerStateTables(tx: DbExecutor): Promise<{ snapshot: boolean; base: boolean }> {
  const rows = await tx.all<unknown>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sync_reducer_snapshot', 'sync_reducer_base')`,
  );
  const names = new Set(rows.map((row) => (Array.isArray(row) ? row[0] : (row as { name?: unknown }).name)));
  return { snapshot: names.has('sync_reducer_snapshot'), base: names.has('sync_reducer_base') };
}

/** Restore replaces a SyncGeneration's journal; its derived snapshots are void. */
export async function deleteSqliteReducerSnapshotsInTransaction(
  tx: DbExecutor,
  syncGenerationId: string,
): Promise<void> {
  if (!(await reducerStateTables(tx)).snapshot) return;
  await tx
    .delete(SyncReducerSnapshotTable)
    .where(eq(SyncReducerSnapshotTable.syncGenerationId, syncGenerationId));
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readReducerSnapshot(
  tx: DbTransaction,
  identity: ReducerSyncGenerationIdentity,
  profileKey: string,
): Promise<{ state: CanonicalReducerState; receiptRows: number } | null> {
  const [row] = await tx
    .select()
    .from(SyncReducerSnapshotTable)
    .where(
      and(
        eq(SyncReducerSnapshotTable.syncGenerationId, identity.syncGenerationId),
        eq(SyncReducerSnapshotTable.profileKey, profileKey),
      ),
    )
    .limit(1);
  if (!row || row.formatVersion !== REDUCER_STATE_SNAPSHOT_FORMAT) return null;
  try {
    const stored = row.stateBlob as Uint8Array;
    const bytes = row.codec === 'cbor+gzip' ? await gunzip(stored) : stored;
    return { state: decodeReducerState(bytes, identity), receiptRows: row.receiptCount };
  } catch {
    return null;
  }
}

async function writeReducerSnapshot(
  tx: DbTransaction,
  state: CanonicalReducerState,
  receiptRows: number,
  profileKey: string,
  nowIso: string,
): Promise<void> {
  const encoded = encodeReducerState(state);
  const compressed = typeof CompressionStream === 'function';
  const values = {
    syncGenerationId: state.identity.syncGenerationId,
    profileKey,
    formatVersion: REDUCER_STATE_SNAPSHOT_FORMAT,
    codec: compressed ? 'cbor+gzip' : 'cbor',
    receiptCount: receiptRows,
    stateBlob: compressed ? await gzip(encoded) : encoded,
    createdAt: nowIso,
  };
  await tx.insert(SyncReducerSnapshotTable).values(values).onConflictDoUpdate({
    target: [SyncReducerSnapshotTable.syncGenerationId, SyncReducerSnapshotTable.profileKey],
    set: {
      formatVersion: values.formatVersion,
      codec: values.codec,
      receiptCount: values.receiptCount,
      stateBlob: values.stateBlob,
      createdAt: values.createdAt,
    },
  });
}

export interface SqliteReducerBase {
  readonly state: CanonicalReducerState;
  readonly header: ReducerStateHeaderV2;
  readonly sourceCheckpointId: string;
}

export function encodeReducerBasePages(pages: readonly Uint8Array[]): Uint8Array {
  return encodeCanonicalCbor([...pages]);
}

/**
 * The authoritative base of a restored SyncGeneration, if any. It is not a
 * cache: a base the current profile cannot use fails closed.
 */
export async function readSqliteReducerBaseInTransaction(
  tx: DbExecutor,
  identity: ReducerSyncGenerationIdentity,
): Promise<SqliteReducerBase | null> {
  if (!(await reducerStateTables(tx)).base) return null;
  const [row] = await tx
    .select()
    .from(SyncReducerBaseTable)
    .where(eq(SyncReducerBaseTable.syncGenerationId, identity.syncGenerationId))
    .limit(1);
  if (!row) return null;
  const container = decodeCanonicalCbor(row.pagesCbor as Uint8Array);
  if (!container.ok || !Array.isArray(container.value) || !container.value.every((page) => page instanceof Uint8Array)) {
    throw new Error(`reducer base of ${identity.syncGenerationId} is not readable`);
  }
  const decoded = decodeReducerStatePagesV2(container.value as Uint8Array[]);
  const { header } = decoded;
  if (
    header.identity.projectId !== identity.projectId ||
    header.identity.projectSyncId !== identity.projectSyncId ||
    header.identity.syncGenerationId !== identity.syncGenerationId ||
    reducerProfileDescriptionKey(header.profile) !== row.profileKey
  ) {
    throw new Error(`reducer base of ${identity.syncGenerationId} does not match its SyncGeneration`);
  }
  return {
    state: reducerStateFromSnapshot(decoded.snapshot),
    header,
    sourceCheckpointId: row.sourceCheckpointId,
  };
}

/** Installs the authoritative base a checkpoint restore carries. */
export async function installSqliteReducerBaseInTransaction(
  tx: DbExecutor,
  input: {
    syncGenerationId: string;
    profile: ReducerStateProfileV2;
    pages: readonly Uint8Array[];
    sourceCheckpointId: string;
    nowIso: string;
  },
): Promise<void> {
  await tx.insert(SyncReducerBaseTable).values({
    syncGenerationId: input.syncGenerationId,
    profileKey: reducerProfileDescriptionKey(input.profile),
    payloadVersion: 2,
    pagesCbor: encodeReducerBasePages(input.pages),
    sourceCheckpointId: input.sourceCheckpointId,
    createdAt: input.nowIso,
  });
}

function appliedJoin() {
  return and(
    eq(SyncApplyReceiptTable.changeSetId, SyncChangeSetTable.changeSetId),
    eq(SyncApplyReceiptTable.syncGenerationId, SyncChangeSetTable.syncGenerationId),
  );
}

function lanes(state: CanonicalReducerState): { writerId: string; writerEpoch: string; seq: number }[] {
  return [...state.coverage].map(([lane, seq]) => {
    const [writerId, writerEpoch] = JSON.parse(lane) as [string, string];
    return { writerId, writerEpoch, seq };
  });
}

/**
 * A compacted state is consistent with SQLite when every explicit receipt is
 * applied and every covered sequence above the base's floor is applied.
 * Below the floor the base itself is the authority.
 */
async function isAccountedFor(
  tx: DbTransaction,
  identity: ReducerSyncGenerationIdentity,
  state: CanonicalReducerState,
  floor: ReadonlyMap<string, number>,
  excludeChangeSetId: string,
): Promise<boolean> {
  const receipts = [...state.receipts.keys()];
  if (receipts.includes(excludeChangeSetId)) return false;
  for (let offset = 0; offset < receipts.length; offset += ID_BATCH) {
    const batch = receipts.slice(offset, offset + ID_BATCH);
    const [found] = await tx
      .select({ value: count() })
      .from(SyncChangeSetTable)
      .innerJoin(SyncApplyReceiptTable, appliedJoin())
      .where(and(
        eq(SyncChangeSetTable.syncGenerationId, identity.syncGenerationId),
        inArray(SyncChangeSetTable.changeSetId, batch),
      ));
    if (Number(found?.value ?? 0) !== batch.length) return false;
  }
  for (const lane of lanes(state)) {
    const from = floor.get(JSON.stringify([lane.writerId, lane.writerEpoch])) ?? 0;
    if (lane.seq <= from) continue;
    const [found] = await tx
      .select({ value: count() })
      .from(SyncChangeSetTable)
      .innerJoin(SyncApplyReceiptTable, appliedJoin())
      .where(and(
        eq(SyncChangeSetTable.syncGenerationId, identity.syncGenerationId),
        eq(SyncChangeSetTable.writerId, lane.writerId),
        eq(SyncChangeSetTable.writerEpoch, lane.writerEpoch),
        gt(SyncChangeSetTable.deviceSeq, from),
        lte(SyncChangeSetTable.deviceSeq, lane.seq),
        ne(SyncChangeSetTable.changeSetId, excludeChangeSetId),
      ));
    if (Number(found?.value ?? 0) !== lane.seq - from) return false;
  }
  return true;
}

/** Applied change-sets a compacted state neither covers nor receipts explicitly. */
async function uncoveredChangeSets(
  tx: DbTransaction,
  identity: ReducerSyncGenerationIdentity,
  state: CanonicalReducerState,
  excludeChangeSetId: string,
): Promise<SyncChangeSetV1[]> {
  const covered = lanes(state);
  const generation = eq(SyncChangeSetTable.syncGenerationId, identity.syncGenerationId);
  const columns = { changeSetId: SyncChangeSetTable.changeSetId, encodedBytes: SyncChangeSetTable.encodedBytes };
  const rows: { changeSetId: string; encodedBytes: unknown }[] = [];
  const append = (batch: readonly { changeSetId: string; encodedBytes: unknown }[]) => {
    for (const row of batch) rows.push(row);
  };
  for (const lane of covered) {
    append(await tx
      .select(columns)
      .from(SyncChangeSetTable)
      .innerJoin(SyncApplyReceiptTable, appliedJoin())
      .where(and(
        generation,
        eq(SyncChangeSetTable.writerId, lane.writerId),
        eq(SyncChangeSetTable.writerEpoch, lane.writerEpoch),
        gt(SyncChangeSetTable.deviceSeq, lane.seq),
      )));
  }
  append(await tx
    .select(columns)
    .from(SyncChangeSetTable)
    .innerJoin(SyncApplyReceiptTable, appliedJoin())
    .where(and(
      generation,
      ...covered.map((lane) => or(
        ne(SyncChangeSetTable.writerId, lane.writerId),
        ne(SyncChangeSetTable.writerEpoch, lane.writerEpoch),
      )),
    )));

  const changeSets: SyncChangeSetV1[] = [];
  for (const row of rows) {
    if (row.changeSetId === excludeChangeSetId || state.receipts.has(row.changeSetId)) continue;
    const decoded = await decodeSyncChangeSetV1(row.encodedBytes as Uint8Array);
    if (!decoded.ok) {
      throw new SyncReducerRejectedError(
        'stored-change-set-invalid',
        `/sync_change_set/${row.changeSetId}`,
        decoded.reason,
      );
    }
    changeSets.push(decoded.value);
  }
  return changeSets.sort((left, right) =>
    compareSyncTotalOrder(
      { hlc: left.hlc, writerId: left.writerId, writerEpoch: left.writerEpoch, deviceSeq: left.deviceSeq, mutationIndex: 0 },
      { hlc: right.hlc, writerId: right.writerId, writerEpoch: right.writerEpoch, deviceSeq: right.deviceSeq, mutationIndex: 0 },
    ) || compareUtf8Bytewise(left.changeSetId, right.changeSetId),
  );
}

async function rebuildReducerState(
  tx: DbTransaction,
  identity: ReducerSyncGenerationIdentity,
  profile: ReducerProfile,
  excludeChangeSetId: string,
): Promise<{ state: CanonicalReducerState; snapshotRows: number | null }> {
  const started = Date.now();
  const endActivity = beginDevActivity('sync-reducer-rebuild', { syncGenerationId: identity.syncGenerationId });
  try {
    const profileKey = persistentReducerProfileKey(profile);
    const tables = await reducerStateTables(tx);
    const base = await readSqliteReducerBaseInTransaction(tx, identity);
    if (base && reducerProfileDescriptionKey(base.header.profile) !== profileKey) {
      throw new Error('this SyncGeneration was restored under a different reducer profile');
    }
    const floor = base?.state.coverage ?? new Map<string, number>();
    let start: { state: CanonicalReducerState; source: SqliteReducerLoadDiagnostics['source'] } = base
      ? { state: base.state, source: 'base' }
      : { state: createCanonicalReducerState(identity), source: 'journal' };
    let snapshotRows: number | null = null;
    if (profileKey !== null && tables.snapshot) {
      const snapshot = await readReducerSnapshot(tx, identity, profileKey);
      if (snapshot && (await isAccountedFor(tx, identity, snapshot.state, floor, excludeChangeSetId))) {
        start = { state: snapshot.state, source: 'snapshot' };
        snapshotRows = snapshot.receiptRows;
      } else if (snapshot) {
        await deleteSqliteReducerSnapshotsInTransaction(tx, identity.syncGenerationId);
      }
    }
    if (start.source === 'base' && !(await isAccountedFor(tx, identity, start.state, floor, excludeChangeSetId))) {
      throw new Error('the restored reducer base references change-sets missing from SQLite');
    }

    const changeSets = await uncoveredChangeSets(tx, identity, start.state, excludeChangeSetId);
    let state = start.state;
    if (changeSets.length > 0) {
      const replayed = replaySyncChangeSets(state, changeSets, profile);
      if (replayed.status === 'rejected') {
        throw new SyncReducerRejectedError(
          replayed.rejection.code,
          replayed.rejection.path,
          replayed.rejection.message,
        );
      }
      state = replayed.state;
    }
    lastReducerLoad = {
      syncGenerationId: identity.syncGenerationId,
      source: start.source,
      startReceipts: start.state.receipts.size,
      replayedChangeSets: changeSets.length,
      durationMs: Date.now() - started,
    };
    return { state: compactReducerReceipts(state), snapshotRows };
  } finally {
    endActivity();
  }
}

/**
 * Canonical state for the receipt-backed history of a SyncGeneration,
 * excluding `excludeChangeSetId` (the change-set currently being applied).
 */
export async function loadSqliteReducerStateInTransaction(
  tx: DbTransaction,
  identity: ReducerSyncGenerationIdentity,
  profile: ReducerProfile,
  excludeChangeSetId: string,
): Promise<StoredReducerState & { readonly rebuilt: boolean }> {
  const cacheKey = reducerCacheKey(identity, profile);
  const [receiptCount] = await tx
    .select({ value: count() })
    .from(SyncApplyReceiptTable)
    .where(eq(SyncApplyReceiptTable.syncGenerationId, identity.syncGenerationId));
  const currentReceipt = await tx
    .select({ changeSetId: SyncApplyReceiptTable.changeSetId })
    .from(SyncApplyReceiptTable)
    .where(
      and(
        eq(SyncApplyReceiptTable.syncGenerationId, identity.syncGenerationId),
        eq(SyncApplyReceiptTable.changeSetId, excludeChangeSetId),
      ),
    )
    .limit(1);
  const receiptRows = Number(receiptCount?.value ?? 0) - currentReceipt.length;
  const cached = reducerStateCache.get(cacheKey);
  if (cached?.current.receiptRows === receiptRows) return { ...cached.current, rebuilt: false };
  if (cached?.previous?.receiptRows === receiptRows) {
    // The optimistic write that produced `cached.current` did not commit.
    reducerStateCache.set(cacheKey, { current: cached.previous, previous: null });
    return { ...cached.previous, rebuilt: false };
  }

  const rebuilt = await rebuildReducerState(tx, identity, profile, excludeChangeSetId);
  const stored: StoredReducerState = { state: rebuilt.state, receiptRows, effects: null };
  reducerStateCache.set(cacheKey, { current: stored, previous: null });
  persistedSnapshotRows.set(cacheKey, rebuilt.snapshotRows ?? 0);
  return { ...stored, rebuilt: true };
}

/**
 * Records the state an apply produced. The cache write is optimistic and
 * rollback-safe: the next load checks SQLite's receipt rows first and falls
 * back to `previous`, or rebuilds, if this outer transaction did not commit.
 */
export function rememberSqliteReducerState(
  identity: ReducerSyncGenerationIdentity,
  profile: ReducerProfile,
  next: StoredReducerState,
  previous: StoredReducerState,
): void {
  reducerStateCache.set(reducerCacheKey(identity, profile), { current: next, previous });
}

/**
 * Compacts receipt-backed history into a snapshot once enough receipt rows
 * are not covered by the newest one. Written in the applying transaction, so
 * it never covers a receipt that did not commit.
 */
export async function persistSqliteReducerSnapshotIfDue(
  tx: DbTransaction,
  identity: ReducerSyncGenerationIdentity,
  profile: ReducerProfile,
  stored: StoredReducerState,
  nowIso: string,
): Promise<void> {
  const profileKey = persistentReducerProfileKey(profile);
  if (profileKey === null) return;
  const cacheKey = reducerCacheKey(identity, profile);
  const covered = persistedSnapshotRows.get(cacheKey) ?? 0;
  if (stored.receiptRows - covered < snapshotInterval) return;
  if (!(await reducerStateTables(tx)).snapshot) {
    persistedSnapshotRows.set(cacheKey, Number.POSITIVE_INFINITY);
    return;
  }
  const endActivity = beginDevActivity('sync-reducer-snapshot', { receiptRows: stored.receiptRows });
  try {
    await writeReducerSnapshot(tx, compactReducerReceipts(stored.state), stored.receiptRows, profileKey, nowIso);
  } finally {
    endActivity();
  }
  persistedSnapshotRows.set(cacheKey, stored.receiptRows);
}
