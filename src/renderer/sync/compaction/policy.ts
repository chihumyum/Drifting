import { and, eq, isNull } from 'drizzle-orm';

import type { DbClient } from '../../lib/db';
import {
  SyncCursorTable,
  SyncLocalObjectTable,
  SyncRemoteObjectTable,
  SyncSegmentTable,
} from '../../schema/drizzle';
import { captureFrontier } from '../checkpoint/capture';
import type { SyncEngineObjectCodec } from '../engine/object-codec';
import {
  createProviderCursor,
  createProviderObjectId,
  type ObjectLogProvider,
  type ProviderGeneration,
  type ProviderObjectId,
} from '../protocol';
import {
  frontierCovers,
  frontierDominates,
  frontierLaneKey,
  laneFrontierFromSnapshot,
  minimumFrontier,
  type LaneFrontier,
} from './frontier';
import {
  loadRemoteSnapshotCatalog,
  snapshotObjectIds,
  validateCatalogSnapshot,
  type RemoteSnapshotEntry,
} from './snapshot-catalog';

/** Snapshots kept after pruning; the older one is a complete fallback. */
export const RETAINED_SNAPSHOTS = 2;
export const DEFAULT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_PRUNE_IDS_PER_REQUEST = 512;

export type PruneOutcome =
  | { readonly status: 'skipped'; readonly reason: string }
  | {
      readonly status: 'pruned';
      readonly removed: readonly ProviderObjectId[];
      readonly deferred: readonly ProviderObjectId[];
    }
  | { readonly status: 'failed'; readonly error: unknown };

export interface PrunePlan {
  readonly retain: readonly ProviderObjectId[];
  readonly removeSnapshots: readonly ProviderObjectId[];
  readonly removeSegments: readonly ProviderObjectId[];
  readonly coveredFrontier: LaneFrontier;
}

export interface SyncLogCompactorOptions {
  readonly db: DbClient;
  readonly syncGenerationId: string;
  readonly provider: ObjectLogProvider;
  readonly providerGeneration: ProviderGeneration;
  readonly objectCodec: SyncEngineObjectCodec;
  /** Pruning is opt-in; the publish guard always applies. */
  readonly pruneEnabled: boolean;
  readonly pruneIntervalMs?: number;
  readonly nowMs?: () => number;
}

async function localAppliedFrontier(db: DbClient, syncGenerationId: string): Promise<LaneFrontier> {
  return laneFrontierFromSnapshot(await captureFrontier(db, syncGenerationId));
}

/**
 * Remote segments whose whole range every retained snapshot already covers.
 * Only ingested segments have a known lane and range; anything else stays.
 */
async function coveredRemoteSegments(
  db: DbClient,
  syncGenerationId: string,
  covered: LaneFrontier,
): Promise<ProviderObjectId[]> {
  if (covered.size === 0) return [];
  const rows = await db
    .select({
      writerId: SyncSegmentTable.writerId,
      writerEpoch: SyncSegmentTable.writerEpoch,
      lastSeq: SyncSegmentTable.lastSeq,
      objectId: SyncRemoteObjectTable.providerObjectId,
    })
    .from(SyncSegmentTable)
    .innerJoin(SyncLocalObjectTable, eq(SyncLocalObjectTable.id, SyncSegmentTable.localObjectId))
    .innerJoin(
      SyncRemoteObjectTable,
      and(
        eq(SyncRemoteObjectTable.syncGenerationId, SyncSegmentTable.syncGenerationId),
        eq(SyncRemoteObjectTable.logicalKeyId, SyncLocalObjectTable.logicalKeyId),
      ),
    )
    .where(
      and(
        eq(SyncSegmentTable.syncGenerationId, syncGenerationId),
        eq(SyncRemoteObjectTable.objectKind, 'segment'),
        isNull(SyncRemoteObjectTable.removedAt),
      ),
    );
  return rows
    .filter((row) => frontierCovers(covered, frontierLaneKey(row.writerId, row.writerEpoch), row.lastSeq))
    .map((row) => createProviderObjectId(row.objectId));
}

/**
 * Pure selection: keep the newest snapshots and remove every older one.
 * Segments below the minimum of the retained frontiers may go too: each
 * retained snapshot covers all removed history, so any one of them plus the
 * remaining segments still reconstructs everything ever published.
 */
export function planPrune(entries: readonly RemoteSnapshotEntry[]): Omit<PrunePlan, 'removeSegments'> | null {
  if (entries.length < RETAINED_SNAPSHOTS) return null;
  const retained = entries.slice(0, RETAINED_SNAPSHOTS);
  return {
    retain: retained.flatMap(snapshotObjectIds),
    removeSnapshots: entries.slice(RETAINED_SNAPSHOTS).flatMap(snapshotObjectIds),
    coveredFrontier: minimumFrontier(retained.map((entry) => entry.frontier)),
  };
}

function* pruneBatches(plan: PrunePlan): Generator<ProviderObjectId[]> {
  // Snapshot pairs go first and never straddle a request: a package may only
  // leave together with a marker.
  const pairs: ProviderObjectId[][] = [];
  for (let index = 0; index < plan.removeSnapshots.length; index += 2) {
    pairs.push(plan.removeSnapshots.slice(index, index + 2));
  }
  let batch: ProviderObjectId[] = [];
  for (const pair of pairs) {
    if (batch.length + pair.length > MAX_PRUNE_IDS_PER_REQUEST) {
      yield batch;
      batch = [];
    }
    batch.push(...pair);
  }
  for (const segment of plan.removeSegments) {
    if (batch.length >= MAX_PRUNE_IDS_PER_REQUEST) {
      yield batch;
      batch = [];
    }
    batch.push(segment);
  }
  if (batch.length > 0) yield batch;
}

/**
 * Raft-style log compaction for one SyncGeneration: a checkpoint publish guard
 * so no snapshot regresses below truncated history, and opportunistic pruning
 * of history that the retained snapshots provably cover.
 */
export class SyncLogCompactor {
  private lastPruneAttemptMs: number | null = null;
  private readonly nowMs: () => number;

  constructor(private readonly options: SyncLogCompactorOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  /**
   * A new checkpoint must cover the newest committed snapshot. A device that
   * missed truncated history would otherwise publish a "newest" snapshot that
   * silently drops it.
   */
  async allowsCheckpoint(): Promise<boolean> {
    const { entries } = await loadRemoteSnapshotCatalog(this.options);
    const newest = entries[0];
    if (!newest) return true;
    return frontierDominates(
      await localAppliedFrontier(this.options.db, this.options.syncGenerationId),
      newest.frontier,
    );
  }

  /** Callers run this only when the binding is ready and nothing is blocked. */
  async pruneIfDue(signal: AbortSignal): Promise<PruneOutcome> {
    const pruneObjects = this.options.provider.pruneObjects?.bind(this.options.provider);
    if (!this.options.pruneEnabled || !pruneObjects) {
      return { status: 'skipped', reason: 'pruning-disabled' };
    }
    const nowMs = this.nowMs();
    const interval = this.options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    if (this.lastPruneAttemptMs !== null && nowMs - this.lastPruneAttemptMs < interval) {
      return { status: 'skipped', reason: 'not-due' };
    }
    this.lastPruneAttemptMs = nowMs;
    try {
      const { db, syncGenerationId, objectCodec } = this.options;
      const [cursor] = await db
        .select()
        .from(SyncCursorTable)
        .where(eq(SyncCursorTable.syncGenerationId, syncGenerationId))
        .limit(1);
      if (!cursor?.inventoryComplete || !cursor.committedCursor || cursor.pendingPageToken) {
        return { status: 'skipped', reason: 'cursor-not-drained' };
      }
      const catalog = await loadRemoteSnapshotCatalog(this.options);
      if (catalog.incomplete) return { status: 'skipped', reason: 'catalog-incomplete' };
      const local = await localAppliedFrontier(db, syncGenerationId);
      if (catalog.entries[0] && !frontierDominates(local, catalog.entries[0].frontier)) {
        return { status: 'skipped', reason: 'behind-newest-snapshot' };
      }
      for (const entry of catalog.entries.slice(0, RETAINED_SNAPSHOTS)) {
        await validateCatalogSnapshot({ syncGenerationId, objectCodec, entry });
      }
      const selected = planPrune(catalog.entries);
      if (!selected) return { status: 'skipped', reason: 'too-few-snapshots' };
      const resolved: PrunePlan = {
        ...selected,
        removeSegments: await coveredRemoteSegments(db, syncGenerationId, selected.coveredFrontier),
      };
      if (resolved.removeSnapshots.length === 0 && resolved.removeSegments.length === 0) {
        return { status: 'skipped', reason: 'nothing-covered' };
      }
      const removed: ProviderObjectId[] = [];
      const deferred: ProviderObjectId[] = [];
      for (const remove of pruneBatches(resolved)) {
        if (signal.aborted) throw signal.reason;
        const result = await pruneObjects({
          generation: this.options.providerGeneration,
          basisCursor: createProviderCursor(cursor.committedCursor),
          retain: resolved.retain,
          remove,
          signal,
        });
        removed.push(...result.removed);
        deferred.push(...result.deferred);
      }
      return { status: 'pruned', removed, deferred };
    } catch (error) {
      // Pruning is an optimization: a stale basis, a rejected request or an
      // unavailable provider leaves every object in place for the next round.
      return { status: 'failed', error };
    }
  }
}
