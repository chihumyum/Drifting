import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import type { DbClient, DbTransaction } from '../../lib/db';
import {
  SyncApplyReceiptTable,
  SyncChangeSetTable,
  SyncConflictTable,
  SyncFrontierTable,
  SyncGenerationTable,
  SyncQuarantinedObjectTable,
  SyncSegmentTable,
} from '../../schema/drizzle';
import { importCheckpointJournalInTransaction } from '../checkpoint/reducer-state';
import {
  loadWriterFrontierInTransaction,
  persistWriterFrontierInTransaction,
} from '../engine/sqlite-repository';
import {
  contiguousFrontierSeq,
  observeFrontierRange,
  type WriterFrontierState,
} from '../engine/frontier';
import type { SyncEngineObjectCodec } from '../engine/object-codec';
import {
  observeRemoteHlcInTransaction,
  type SyncJournalClock,
  type SyncWriterIdentitySource,
} from '../journal/writer-state';
import {
  decodeSyncChangeSetV1,
  type Sha256,
  type SnapshotAssetV1,
  type SnapshotFrontierEntryV1,
} from '../protocol';
import {
  fastForwardSqliteReducerOntoCheckpointInTransaction,
  mergeCheckpointProseInTransaction,
  readSqliteReducerBaseInTransaction,
  type SyncDomainMaterializationKernel,
} from '../reducer';
import { frontierDominates, frontierLaneKey } from './frontier';
import { loadRemoteSnapshotCatalog, validateCatalogSnapshot, type RemoteSnapshotEntry } from './snapshot-catalog';

export interface SnapshotCatchUpPlan {
  readonly entry: RemoteSnapshotEntry;
  /** Lanes the snapshot covers further than local segments can ever reach. */
  readonly unreachableLanes: readonly string[];
}

export type SnapshotCatchUpOutcome =
  | {
      readonly status: 'installed';
      readonly snapshotId: string;
      readonly projectId: string;
      readonly proseDocIds: readonly string[];
      readonly assets: readonly SnapshotAssetV1[];
    }
  /** A segment received after the snapshot does not extend its head. */
  | { readonly status: 'forked'; readonly forkedLocalObjectIds: readonly string[] }
  | { readonly status: 'skipped'; readonly reason: string };

/**
 * Detects history this replica can no longer receive: the newest snapshot
 * covers a lane beyond what the replica applied, and no ingested segment
 * chain bridges the difference. Nothing else ever closes such a gap.
 */
export async function planSnapshotCatchUp(input: {
  readonly db: DbClient;
  readonly syncGenerationId: string;
  readonly objectCodec: SyncEngineObjectCodec;
}): Promise<SnapshotCatchUpPlan | null> {
  const { entries } = await loadRemoteSnapshotCatalog(input);
  const newest = entries[0];
  if (!newest) return null;
  const [frontierRows, segmentRows] = await Promise.all([
    input.db
      .select({
        writerId: SyncFrontierTable.writerId,
        writerEpoch: SyncFrontierTable.writerEpoch,
        appliedSeq: SyncFrontierTable.appliedSeq,
      })
      .from(SyncFrontierTable)
      .where(eq(SyncFrontierTable.syncGenerationId, input.syncGenerationId)),
    input.db
      .select({
        writerId: SyncSegmentTable.writerId,
        writerEpoch: SyncSegmentTable.writerEpoch,
        firstSeq: SyncSegmentTable.firstSeq,
        lastSeq: SyncSegmentTable.lastSeq,
      })
      .from(SyncSegmentTable)
      .where(eq(SyncSegmentTable.syncGenerationId, input.syncGenerationId))
      .orderBy(asc(SyncSegmentTable.firstSeq)),
  ]);
  const applied = new Map(
    frontierRows.map((row) => [frontierLaneKey(row.writerId, row.writerEpoch), row.appliedSeq]),
  );
  const unreachableLanes: string[] = [];
  for (const [lane, covered] of newest.frontier) {
    let next = (applied.get(lane) ?? 0) + 1;
    for (const segment of segmentRows) {
      if (frontierLaneKey(segment.writerId, segment.writerEpoch) !== lane) continue;
      if (segment.firstSeq <= next && segment.lastSeq >= next) next = segment.lastSeq + 1;
    }
    if (next <= covered) unreachableLanes.push(lane);
  }
  return unreachableLanes.length > 0 ? { entry: newest, unreachableLanes } : null;
}

function joinFrontier(local: WriterFrontierState, entry: SnapshotFrontierEntryV1): WriterFrontierState | null {
  if (entry.appliedSeq <= contiguousFrontierSeq(local.applied)) return null;
  const range = { firstSeq: 1, lastSeq: entry.appliedSeq };
  const received = observeFrontierRange(local, 'received', range);
  const applied = observeFrontierRange(received, 'applied', range);
  return Object.freeze({ ...applied, segmentHeadSha256: entry.segmentHeadHash as Sha256 | null });
}

/**
 * The segment received right after a fast-forwarded lane was never chained
 * to a predecessor this replica held. It must extend the snapshot's head.
 */
async function forkedSuccessors(
  tx: DbTransaction,
  syncGenerationId: string,
  advanced: readonly WriterFrontierState[],
): Promise<string[]> {
  const forked: string[] = [];
  for (const lane of advanced) {
    const successors = await tx
      .select({ localObjectId: SyncSegmentTable.localObjectId, previous: SyncSegmentTable.previousSegmentSha256 })
      .from(SyncSegmentTable)
      .where(
        and(
          eq(SyncSegmentTable.syncGenerationId, syncGenerationId),
          eq(SyncSegmentTable.writerId, lane.writerId),
          eq(SyncSegmentTable.writerEpoch, lane.writerEpoch),
          eq(SyncSegmentTable.firstSeq, lane.applied.maxSeq + 1),
        ),
      );
    const head = lane.segmentHeadSha256?.slice('sha256:'.length) ?? null;
    for (const successor of successors) {
      if (successor.previous !== head) forked.push(successor.localObjectId);
    }
  }
  return forked;
}

async function scopeChangeSet(tx: DbTransaction, syncGenerationId: string) {
  const [row] = await tx
    .select({ encodedBytes: SyncChangeSetTable.encodedBytes })
    .from(SyncChangeSetTable)
    .innerJoin(
      SyncApplyReceiptTable,
      and(
        eq(SyncApplyReceiptTable.changeSetId, SyncChangeSetTable.changeSetId),
        eq(SyncApplyReceiptTable.syncGenerationId, SyncChangeSetTable.syncGenerationId),
      ),
    )
    .where(eq(SyncChangeSetTable.syncGenerationId, syncGenerationId))
    .orderBy(desc(SyncChangeSetTable.hlcWallMs), desc(SyncChangeSetTable.hlcCounter))
    .limit(1);
  if (!row) throw new Error('a checkpoint fast-forward needs an applied change-set for its scope');
  const decoded = await decodeSyncChangeSetV1(row.encodedBytes as Uint8Array);
  if (!decoded.ok) throw new Error('stored change-set failed verification');
  return decoded.value;
}

/**
 * InstallSnapshot for a multi-writer CRDT: the replica cannot be replaced
 * like a Raft follower, because it may hold edits of its own and device-local
 * data tied to the project. Instead the snapshot becomes the reducer base and
 * every applied change-set it does not cover is replayed on top, one atomic
 * SQLite transaction. Writer identity and local tables are untouched.
 */
export async function installSnapshotCatchUp(input: {
  readonly db: DbClient;
  readonly syncGenerationId: string;
  readonly objectCodec: SyncEngineObjectCodec;
  readonly kernel: SyncDomainMaterializationKernel;
  readonly writerIdentity: SyncWriterIdentitySource;
  readonly clock: () => SyncJournalClock;
  readonly plan: SnapshotCatchUpPlan;
}): Promise<SnapshotCatchUpOutcome> {
  const blocked = await Promise.all([
    input.db
      .select({ id: SyncConflictTable.conflictId })
      .from(SyncConflictTable)
      .where(and(eq(SyncConflictTable.syncGenerationId, input.syncGenerationId), eq(SyncConflictTable.state, 'open')))
      .limit(1),
    input.db
      .select({ id: SyncQuarantinedObjectTable.quarantineId })
      .from(SyncQuarantinedObjectTable)
      .where(
        and(
          eq(SyncQuarantinedObjectTable.syncGenerationId, input.syncGenerationId),
          inArray(SyncQuarantinedObjectTable.state, ['blocked-update', 'blocked-corrupt']),
        ),
      )
      .limit(1),
  ]);
  if (blocked.some((rows) => rows.length > 0)) return { status: 'skipped', reason: 'blocked' };
  const validated = await validateCatalogSnapshot({
    syncGenerationId: input.syncGenerationId,
    objectCodec: input.objectCodec,
    entry: input.plan.entry,
  });
  if (validated.payloadVersion !== 2) return { status: 'skipped', reason: 'payload-v1' };
  const snapshotId = validated.package.snapshotId;
  return input.db.transaction(async (tx) => {
    const [generation] = await tx
      .select()
      .from(SyncGenerationTable)
      .where(eq(SyncGenerationTable.syncGenerationId, input.syncGenerationId))
      .limit(1);
    if (
      !generation?.projectId ||
      generation.status !== 'active' ||
      generation.projectId !== validated.package.projectId ||
      generation.projectSyncId !== validated.package.projectSyncId
    ) {
      return { status: 'skipped', reason: 'generation-mismatch' } as const;
    }
    const identity = {
      projectId: generation.projectId,
      projectSyncId: generation.projectSyncId,
      syncGenerationId: input.syncGenerationId,
    };
    // A replica restored from an older checkpoint lacks the rows its own base
    // covers; replacing that base is safe only when the new one covers it.
    const base = await readSqliteReducerBaseInTransaction(tx, identity);
    if (base && !frontierDominates(validated.reducer.state.coverage, base.state.coverage)) {
      return { status: 'skipped', reason: 'base-not-covered' } as const;
    }
    const clock = input.clock();
    const advanced: WriterFrontierState[] = [];
    for (const entry of validated.package.frontier) {
      const local = await loadWriterFrontierInTransaction(tx, {
        syncGenerationId: input.syncGenerationId,
        writerId: entry.writerId,
        writerEpoch: entry.writerEpoch,
      });
      const joined = joinFrontier(local, entry);
      if (joined) advanced.push(joined);
    }
    const forked = await forkedSuccessors(tx, input.syncGenerationId, advanced);
    if (forked.length > 0) {
      return { status: 'forked', forkedLocalObjectIds: forked } as const;
    }
    await importCheckpointJournalInTransaction(tx, validated.reducer.journal);
    for (const lane of advanced) await persistWriterFrontierInTransaction(tx, lane, clock.nowIso);
    await fastForwardSqliteReducerOntoCheckpointInTransaction(tx, {
      identity,
      baseProfile: validated.reducer.header.profile,
      pages: validated.reducer.pages,
      sourceCheckpointId: snapshotId,
      kernel: input.kernel,
      scopeChangeSet: await scopeChangeSet(tx, input.syncGenerationId),
      nowIso: clock.nowIso,
    });
    // Later local edits must order after everything the snapshot absorbed.
    await observeRemoteHlcInTransaction(tx, {
      syncGenerationId: input.syncGenerationId,
      remoteHlc: validated.maxChangeSetHlc,
      identity: input.writerIdentity,
      clock,
    });
    const proseDocIds: string[] = [];
    for (const document of validated.package.proseDocuments) {
      if (document.mode !== 'full-state') continue;
      const changed = await mergeCheckpointProseInTransaction(tx, {
        projectId: identity.projectId,
        documentId: document.documentId,
        state: new Uint8Array(document.state),
        nowIso: clock.nowIso,
      });
      if (changed) proseDocIds.push(document.documentId);
    }
    return {
      status: 'installed',
      snapshotId,
      projectId: identity.projectId,
      proseDocIds,
      assets: validated.package.assets,
    } as const;
  });
}
