import { and, asc, count, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';

import type { DbClient, DbExecutor, DbTransaction } from '../../lib/db';
import {
  SyncApplyReceiptTable,
  SyncChangeSetTable,
  SyncConflictTable,
  SyncEntityLifecycleTable,
  SyncFieldClockTable,
  SyncFrontierGapTable,
  SyncFrontierTable,
  SyncGenerationPurgeTable,
  SyncGenerationTable,
  SyncJournalTruncationTable,
  SyncMutationTable,
  SyncOrderRegisterTable,
  SyncQuarantinedObjectTable,
  SyncSetTagTable,
} from '../../schema/drizzle';
import { reducerSourceChangeSetIds } from '../checkpoint/reducer-state';
import type { SyncEngineObjectCodec } from '../engine/object-codec';
import {
  canonicalReducerSnapshot,
  DEFAULT_SQLITE_REDUCER_PROFILE,
  deleteSqliteReducerSnapshotsInTransaction,
  invalidateSqliteReducerStateCache,
  loadSqliteReducerStateInTransaction,
  persistentReducerProfileKey,
  readSqliteReducerBaseInTransaction,
  rebaseSqliteReducerOntoAppliedCheckpointInTransaction,
  reducerProfileDescriptionKey,
  sqliteReplayReducerProfile,
  SqliteReducerRebaseMismatchError,
  type ReducerStateProfileV2,
  type SyncDomainMaterializationKernel,
} from '../reducer';
import { frontierDominates, type LaneFrontier } from './frontier';
import {
  loadRemoteSnapshotCatalog,
  validateCatalogSnapshot,
  type RemoteSnapshotEntry,
} from './snapshot-catalog';

/**
 * Change-sets deleted per transaction. About 0.3 ms each on a large desktop
 * journal, so other writes wait well under a quarter second between batches.
 */
const DEFAULT_BATCH_SIZE = 250;
/** Keep `IN (...)` lists far below SQLite's bind-parameter limit. */
const ID_BATCH = 500;

export type JournalTruncationOutcome =
  | { readonly status: 'skipped'; readonly reason: string }
  | {
      readonly status: 'truncated';
      readonly sourceCheckpointId: string;
      /** A newer checkpoint replaced the reducer base in this run. */
      readonly installedBase: boolean;
      readonly deletedChangeSets: number;
      /** Covered change-sets kept because current reducer state names them. */
      readonly retainedChangeSets: number;
    };

interface GenerationIdentity {
  readonly projectId: string;
  readonly projectSyncId: string;
  readonly syncGenerationId: string;
}

type BasePlan =
  | ({
      readonly kind: 'install';
      readonly previousSourceCheckpointId: string | null;
    } & CheckpointBase)
  | {
      readonly kind: 'current';
      readonly sourceCheckpointId: string;
      readonly coverage: LaneFrontier;
      readonly receipts: readonly string[];
    };

async function activeIdentity(db: DbClient, syncGenerationId: string): Promise<GenerationIdentity | null> {
  const [generation] = await db
    .select()
    .from(SyncGenerationTable)
    .where(eq(SyncGenerationTable.syncGenerationId, syncGenerationId))
    .limit(1);
  if (!generation?.projectId || generation.status !== 'active') return null;
  return { projectId: generation.projectId, projectSyncId: generation.projectSyncId, syncGenerationId };
}

/** Anything a person or a later cycle still has to resolve keeps the journal whole. */
async function isBlocked(db: DbClient, syncGenerationId: string): Promise<boolean> {
  const results = await Promise.all([
    db
      .select({ id: SyncConflictTable.conflictId })
      .from(SyncConflictTable)
      .where(and(eq(SyncConflictTable.syncGenerationId, syncGenerationId), eq(SyncConflictTable.state, 'open')))
      .limit(1),
    db
      .select({ id: SyncQuarantinedObjectTable.quarantineId })
      .from(SyncQuarantinedObjectTable)
      .where(
        and(
          eq(SyncQuarantinedObjectTable.syncGenerationId, syncGenerationId),
          inArray(SyncQuarantinedObjectTable.state, ['blocked-update', 'blocked-corrupt']),
        ),
      )
      .limit(1),
    db
      .select({ id: SyncFrontierGapTable.id })
      .from(SyncFrontierGapTable)
      .where(and(eq(SyncFrontierGapTable.syncGenerationId, syncGenerationId), eq(SyncFrontierGapTable.state, 'open')))
      .limit(1),
    db
      .select({ id: SyncChangeSetTable.changeSetId })
      .from(SyncChangeSetTable)
      .where(
        and(
          eq(SyncChangeSetTable.syncGenerationId, syncGenerationId),
          inArray(SyncChangeSetTable.applyState, ['pending', 'applying']),
        ),
      )
      .limit(1),
  ]);
  return results.some((rows) => rows.length > 0);
}

async function appliedFrontier(db: DbClient, syncGenerationId: string): Promise<LaneFrontier> {
  const rows = await db
    .select({
      writerId: SyncFrontierTable.writerId,
      writerEpoch: SyncFrontierTable.writerEpoch,
      appliedSeq: SyncFrontierTable.appliedSeq,
    })
    .from(SyncFrontierTable)
    .where(eq(SyncFrontierTable.syncGenerationId, syncGenerationId));
  return new Map(
    rows.filter((row) => row.appliedSeq > 0).map((row) => [JSON.stringify([row.writerId, row.writerEpoch]), row.appliedSeq]),
  );
}

async function allApplied(db: DbClient, syncGenerationId: string, changeSetIds: readonly string[]): Promise<boolean> {
  for (let offset = 0; offset < changeSetIds.length; offset += ID_BATCH) {
    const batch = changeSetIds.slice(offset, offset + ID_BATCH);
    const [found] = await db
      .select({ value: count() })
      .from(SyncApplyReceiptTable)
      .where(
        and(eq(SyncApplyReceiptTable.syncGenerationId, syncGenerationId), inArray(SyncApplyReceiptTable.changeSetId, batch)),
      );
    if (Number(found?.value ?? 0) !== batch.length) return false;
  }
  return true;
}

interface CheckpointBase {
  readonly sourceCheckpointId: string;
  readonly profile: ReducerStateProfileV2;
  readonly pages: readonly Uint8Array[];
  readonly coverage: LaneFrontier;
  readonly receipts: readonly string[];
}

/**
 * Snapshots whose state, rebuilt with this replica's journal, differed from
 * the current state. Never retried in this session: each try costs a rebuild.
 */
const mismatchedSnapshots = new Set<string>();

/** Verified reducer sections by package hash; a package's bytes never change. */
const checkpointBases = new Map<string, CheckpointBase | null>();
const CHECKPOINT_BASE_CACHE_LIMIT = 4;

/** The reducer section of a payload v2 snapshot of this project, fully validated. */
async function checkpointBase(
  identity: GenerationIdentity,
  objectCodec: SyncEngineObjectCodec,
  entry: RemoteSnapshotEntry,
): Promise<CheckpointBase | null> {
  const key = `${identity.syncGenerationId}:${entry.marker.packageSha256}`;
  if (checkpointBases.has(key)) return checkpointBases.get(key)!;
  const validated = await validateCatalogSnapshot({ syncGenerationId: identity.syncGenerationId, objectCodec, entry });
  const base = validated.payloadVersion === 2 &&
    validated.package.projectId === identity.projectId &&
    validated.package.projectSyncId === identity.projectSyncId
    ? {
        sourceCheckpointId: validated.package.snapshotId,
        profile: validated.reducer.header.profile,
        pages: validated.reducer.pages,
        coverage: validated.reducer.state.coverage,
        receipts: [...validated.reducer.state.receipts.keys()],
      }
    : null;
  if (checkpointBases.size >= CHECKPOINT_BASE_CACHE_LIMIT) checkpointBases.delete(checkpointBases.keys().next().value!);
  checkpointBases.set(key, base);
  return base;
}

/**
 * The newest published snapshot this replica has applied in full becomes the
 * base. It must cover more than the current base, so the base only ever moves
 * forward and later snapshots, which cover the newest one, keep covering it.
 */
async function planBase(input: {
  readonly db: DbClient;
  readonly identity: GenerationIdentity;
  readonly objectCodec: SyncEngineObjectCodec;
  readonly profileKey: string;
}): Promise<BasePlan | null> {
  const { db, identity } = input;
  const syncGenerationId = identity.syncGenerationId;
  const [base, applied, catalog] = await Promise.all([
    readSqliteReducerBaseInTransaction(db, identity),
    appliedFrontier(db, syncGenerationId),
    loadRemoteSnapshotCatalog({ db, syncGenerationId, objectCodec: input.objectCodec }),
  ]);
  const baseCoverage: LaneFrontier = base?.state.coverage ?? new Map();
  // Catch-up refuses a snapshot below the base, so a base the newest snapshot
  // does not cover could leave this replica unable to fast-forward later.
  const newest = catalog.entries[0]?.frontier;
  for (const entry of catalog.entries) {
    if (entry.snapshotId === base?.sourceCheckpointId) break;
    if (
      mismatchedSnapshots.has(`${syncGenerationId}:${entry.snapshotId}`) ||
      !newest ||
      !frontierDominates(newest, entry.frontier) ||
      !frontierDominates(applied, entry.frontier) ||
      !frontierDominates(entry.frontier, baseCoverage) ||
      frontierDominates(baseCoverage, entry.frontier)
    ) {
      continue;
    }
    const candidate = await checkpointBase(identity, input.objectCodec, entry);
    if (
      !candidate ||
      reducerProfileDescriptionKey(candidate.profile) !== input.profileKey ||
      !frontierDominates(newest, candidate.coverage) ||
      !frontierDominates(applied, candidate.coverage) ||
      !frontierDominates(candidate.coverage, baseCoverage) ||
      frontierDominates(baseCoverage, candidate.coverage) ||
      !(await allApplied(db, syncGenerationId, candidate.receipts))
    ) {
      continue;
    }
    return { kind: 'install', previousSourceCheckpointId: base?.sourceCheckpointId ?? null, ...candidate };
  }
  if (!base) return null;
  return {
    kind: 'current',
    sourceCheckpointId: base.sourceCheckpointId,
    coverage: baseCoverage,
    receipts: [...base.state.receipts.keys()],
  };
}

/** Raises each lane's floor to the base coverage; returns whether any moved. */
async function recordFloorInTransaction(
  tx: DbTransaction,
  input: { syncGenerationId: string; coverage: LaneFrontier; sourceCheckpointId: string; nowIso: string },
): Promise<boolean> {
  const current = new Map(
    (
      await tx
        .select()
        .from(SyncJournalTruncationTable)
        .where(eq(SyncJournalTruncationTable.syncGenerationId, input.syncGenerationId))
    ).map((row) => [JSON.stringify([row.writerId, row.writerEpoch]), row.truncatedThroughSeq]),
  );
  let moved = false;
  for (const [lane, seq] of input.coverage) {
    if (seq <= (current.get(lane) ?? 0)) continue;
    moved = true;
    const [writerId, writerEpoch] = JSON.parse(lane) as [string, string];
    await tx
      .insert(SyncJournalTruncationTable)
      .values({
        syncGenerationId: input.syncGenerationId,
        writerId,
        writerEpoch,
        truncatedThroughSeq: seq,
        sourceCheckpointId: input.sourceCheckpointId,
        updatedAt: input.nowIso,
      })
      .onConflictDoUpdate({
        target: [
          SyncJournalTruncationTable.syncGenerationId,
          SyncJournalTruncationTable.writerId,
          SyncJournalTruncationTable.writerEpoch,
        ],
        set: {
          truncatedThroughSeq: sql`max(${SyncJournalTruncationTable.truncatedThroughSeq}, excluded.truncated_through_seq)`,
          sourceCheckpointId: input.sourceCheckpointId,
          updatedAt: input.nowIso,
        },
      });
  }
  return moved;
}

/**
 * Applied change-sets at or below the floor, excluding this installation's
 * own change-sets until their segment is published.
 */
async function coveredChangeSetIds(
  tx: DbExecutor,
  syncGenerationId: string,
  coverage: LaneFrontier,
): Promise<string[]> {
  const ids: string[] = [];
  for (const [lane, seq] of coverage) {
    const [writerId, writerEpoch] = JSON.parse(lane) as [string, string];
    const rows = await tx
      .select({ changeSetId: SyncChangeSetTable.changeSetId })
      .from(SyncChangeSetTable)
      .innerJoin(
        SyncApplyReceiptTable,
        and(
          eq(SyncApplyReceiptTable.changeSetId, SyncChangeSetTable.changeSetId),
          eq(SyncApplyReceiptTable.syncGenerationId, SyncChangeSetTable.syncGenerationId),
        ),
      )
      .leftJoin(
        SyncFrontierTable,
        and(
          eq(SyncFrontierTable.syncGenerationId, SyncChangeSetTable.syncGenerationId),
          eq(SyncFrontierTable.writerId, SyncChangeSetTable.writerId),
          eq(SyncFrontierTable.writerEpoch, SyncChangeSetTable.writerEpoch),
        ),
      )
      .where(
        and(
          eq(SyncChangeSetTable.syncGenerationId, syncGenerationId),
          eq(SyncChangeSetTable.writerId, writerId),
          eq(SyncChangeSetTable.writerEpoch, writerEpoch),
          lte(SyncChangeSetTable.deviceSeq, seq),
          eq(SyncChangeSetTable.applyState, 'applied'),
          or(
            eq(SyncChangeSetTable.origin, 'remote'),
            and(
              lte(SyncChangeSetTable.deviceSeq, sql<number>`coalesce(${SyncFrontierTable.publishedSeq}, 0)`),
              // The published lane may skip a segment still waiting on blobs.
              sql`not exists (
                select 1 from ${SyncFrontierGapTable}
                where ${SyncFrontierGapTable.syncGenerationId} = ${SyncChangeSetTable.syncGenerationId}
                  and ${SyncFrontierGapTable.writerId} = ${SyncChangeSetTable.writerId}
                  and ${SyncFrontierGapTable.writerEpoch} = ${SyncChangeSetTable.writerEpoch}
                  and ${SyncFrontierGapTable.lane} = 'published'
                  and ${SyncFrontierGapTable.state} = 'open'
                  and ${SyncChangeSetTable.deviceSeq} between ${SyncFrontierGapTable.firstSeq} and ${SyncFrontierGapTable.lastSeq}
              )`,
            ),
          ),
        ),
      )
      .orderBy(asc(SyncChangeSetTable.deviceSeq));
    for (const row of rows) ids.push(row.changeSetId);
  }
  return ids;
}

/**
 * Change-sets reducer metadata rows name. Their restrict foreign keys would
 * reject the delete anyway; excluding them keeps the batch from failing.
 */
async function pinnedChangeSetIds(tx: DbTransaction, syncGenerationId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const add = (rows: readonly { id: string | null }[]) => {
    for (const row of rows) if (row.id !== null) ids.add(row.id);
  };
  add(await tx.select({ id: SyncFieldClockTable.changeSetId }).from(SyncFieldClockTable)
    .where(eq(SyncFieldClockTable.syncGenerationId, syncGenerationId)));
  add(await tx.select({ id: SyncSetTagTable.addChangeSetId }).from(SyncSetTagTable)
    .where(eq(SyncSetTagTable.syncGenerationId, syncGenerationId)));
  add(await tx.select({ id: SyncSetTagTable.removedByChangeSetId }).from(SyncSetTagTable)
    .where(and(eq(SyncSetTagTable.syncGenerationId, syncGenerationId), isNotNull(SyncSetTagTable.removedByChangeSetId))));
  add(await tx.select({ id: SyncOrderRegisterTable.changeSetId }).from(SyncOrderRegisterTable)
    .where(eq(SyncOrderRegisterTable.syncGenerationId, syncGenerationId)));
  add(await tx.select({ id: SyncEntityLifecycleTable.changeSetId }).from(SyncEntityLifecycleTable)
    .where(eq(SyncEntityLifecycleTable.syncGenerationId, syncGenerationId)));
  add(await tx.select({ id: SyncGenerationPurgeTable.changeSetId }).from(SyncGenerationPurgeTable)
    .where(eq(SyncGenerationPurgeTable.syncGenerationId, syncGenerationId)));
  add(await tx.select({ id: SyncConflictTable.changeSetId }).from(SyncConflictTable)
    .where(and(eq(SyncConflictTable.syncGenerationId, syncGenerationId), isNotNull(SyncConflictTable.changeSetId))));
  return ids;
}

/** Deletes whole change-sets: receipt and mutations first, which reference the row. */
async function deleteChangeSetsInTransaction(
  tx: DbTransaction,
  syncGenerationId: string,
  changeSetIds: readonly string[],
  pinned: ReadonlySet<string>,
): Promise<number> {
  if (changeSetIds.length === 0) return 0;
  const deletable = changeSetIds.filter((id) => !pinned.has(id));
  for (let offset = 0; offset < deletable.length; offset += ID_BATCH) {
    const batch = deletable.slice(offset, offset + ID_BATCH);
    await tx
      .delete(SyncApplyReceiptTable)
      .where(and(eq(SyncApplyReceiptTable.syncGenerationId, syncGenerationId), inArray(SyncApplyReceiptTable.changeSetId, batch)));
    await tx.delete(SyncMutationTable).where(inArray(SyncMutationTable.changeSetId, batch));
    await tx
      .delete(SyncChangeSetTable)
      .where(and(eq(SyncChangeSetTable.syncGenerationId, syncGenerationId), inArray(SyncChangeSetTable.changeSetId, batch)));
  }
  // The receipt count keys the reducer cache; fewer rows must never match it.
  invalidateSqliteReducerStateCache(syncGenerationId);
  return deletable.length;
}

/**
 * Raft-style log truncation for this replica's own journal. The newest
 * published snapshot whose whole history this replica has applied becomes the
 * reducer base, verified to reproduce the current reducer state exactly, and
 * the floor of every lane it covers is recorded in the same transaction. The
 * change-set, mutation and apply-receipt rows at or below the floor are then
 * deleted, except rows the reducer state or its metadata still name, the
 * base's explicit receipts and own change-sets whose segment is not yet
 * published. Yjs materialization receipts stay as watermarks.
 */
export async function truncateCoveredJournal(input: {
  readonly db: DbClient;
  readonly syncGenerationId: string;
  readonly objectCodec: SyncEngineObjectCodec;
  readonly kernel?: SyncDomainMaterializationKernel;
  readonly nowIso: () => string;
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
}): Promise<JournalTruncationOutcome> {
  const { db, syncGenerationId } = input;
  const identity = await activeIdentity(db, syncGenerationId);
  if (!identity) return { status: 'skipped', reason: 'generation-inactive' };
  if (await isBlocked(db, syncGenerationId)) return { status: 'skipped', reason: 'blocked' };
  const replayProfile = sqliteReplayReducerProfile(DEFAULT_SQLITE_REDUCER_PROFILE, input.kernel);
  const profileKey = persistentReducerProfileKey(replayProfile);
  if (profileKey === null) return { status: 'skipped', reason: 'profile-not-persistent' };
  const plan = await planBase({ db, identity, objectCodec: input.objectCodec, profileKey });
  if (!plan) return { status: 'skipped', reason: 'no-covering-snapshot' };

  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const first = await db.transaction(async (tx) => {
    const base = await readSqliteReducerBaseInTransaction(tx, identity);
    const expected = plan.kind === 'install' ? plan.previousSourceCheckpointId : plan.sourceCheckpointId;
    if ((base?.sourceCheckpointId ?? null) !== expected) return null;
    const state = plan.kind === 'install'
      ? await rebaseSqliteReducerOntoAppliedCheckpointInTransaction(tx, {
          identity,
          baseProfile: plan.profile,
          pages: plan.pages,
          sourceCheckpointId: plan.sourceCheckpointId,
          kernel: input.kernel,
          nowIso: input.nowIso(),
        })
      : (await loadSqliteReducerStateInTransaction(tx, identity, replayProfile, '')).state;
    const floorMoved = await recordFloorInTransaction(tx, {
      syncGenerationId,
      coverage: plan.coverage,
      sourceCheckpointId: plan.sourceCheckpointId,
      nowIso: input.nowIso(),
    });
    const retained = reducerSourceChangeSetIds(canonicalReducerSnapshot(state));
    for (const id of plan.receipts) retained.add(id);
    // Metadata only ever names newer change-sets after this point, so the set
    // read once stays sufficient; its restrict foreign keys still guard each
    // later batch, which then rolls back and leaves the rest for another run.
    for (const id of await pinnedChangeSetIds(tx, syncGenerationId)) retained.add(id);
    const covered = await coveredChangeSetIds(tx, syncGenerationId, plan.coverage);
    const candidates = covered.filter((id) => !retained.has(id));
    const deleted = await deleteChangeSetsInTransaction(tx, syncGenerationId, candidates.slice(0, batchSize), retained);
    return { covered: covered.length, candidates, deleted, changed: plan.kind === 'install' || floorMoved || deleted > 0 };
  }).catch((error: unknown) => {
    if (!(error instanceof SqliteReducerRebaseMismatchError)) throw error;
    mismatchedSnapshots.add(`${syncGenerationId}:${error.sourceCheckpointId}`);
    return 'state-mismatch' as const;
  });
  if (first === 'state-mismatch') {
    invalidateSqliteReducerStateCache(syncGenerationId);
    return { status: 'skipped', reason: 'state-mismatch' };
  }
  if (!first) return { status: 'skipped', reason: 'base-changed' };
  if (first.changed) invalidateSqliteReducerStateCache(syncGenerationId);
  if (!first.changed && first.candidates.length === 0) return { status: 'skipped', reason: 'nothing-covered' };

  let deleted = first.deleted;
  const none: ReadonlySet<string> = new Set();
  for (let offset = batchSize; offset < first.candidates.length; offset += batchSize) {
    if (input.signal?.aborted) throw input.signal.reason;
    const batch = first.candidates.slice(offset, offset + batchSize);
    deleted += await db.transaction((tx) => deleteChangeSetsInTransaction(tx, syncGenerationId, batch, none));
    invalidateSqliteReducerStateCache(syncGenerationId);
  }
  if (deleted > 0) {
    // A derived snapshot written between batches counted the receipts before
    // this run; with far fewer rows it would stay due-but-stale for long.
    await db.transaction((tx) => deleteSqliteReducerSnapshotsInTransaction(tx, syncGenerationId));
    invalidateSqliteReducerStateCache(syncGenerationId);
  }
  return {
    status: 'truncated',
    sourceCheckpointId: plan.sourceCheckpointId,
    installedBase: plan.kind === 'install',
    deletedChangeSets: deleted,
    retainedChangeSets: first.covered - deleted,
  };
}
