import { and, eq, inArray } from 'drizzle-orm';

import type { DbClient } from '../../lib/db';
import {
  SyncFrontierTable,
  SyncLocalObjectTable,
  SyncQuarantinedObjectTable,
  SyncRemoteObjectTable,
  SyncSegmentTable,
  SyncTransferTable,
} from '../../schema/drizzle';
import { frontierLaneKey } from './frontier';

const DELETE_BATCH = 200;

/**
 * Drops the local copies of segments the provider has pruned once this
 * replica has applied them. Journal rows stay: reducer metadata references
 * them. The newest segment of every lane stays too, because sealing chains a
 * writer's next segment to its predecessor. Unreferenced object files are
 * removed by the startup orphan sweep.
 */
export async function truncatePrunedLocalSegments(db: DbClient, syncGenerationId: string): Promise<number> {
  const [segments, frontier] = await Promise.all([
    db
      .select({
        segmentId: SyncSegmentTable.segmentId,
        writerId: SyncSegmentTable.writerId,
        writerEpoch: SyncSegmentTable.writerEpoch,
        lastSeq: SyncSegmentTable.lastSeq,
        localObjectId: SyncSegmentTable.localObjectId,
        removedAt: SyncRemoteObjectTable.removedAt,
      })
      .from(SyncSegmentTable)
      .innerJoin(SyncLocalObjectTable, eq(SyncLocalObjectTable.id, SyncSegmentTable.localObjectId))
      .leftJoin(
        SyncRemoteObjectTable,
        and(
          eq(SyncRemoteObjectTable.syncGenerationId, SyncSegmentTable.syncGenerationId),
          eq(SyncRemoteObjectTable.logicalKeyId, SyncLocalObjectTable.logicalKeyId),
        ),
      )
      .where(eq(SyncSegmentTable.syncGenerationId, syncGenerationId)),
    db
      .select({
        writerId: SyncFrontierTable.writerId,
        writerEpoch: SyncFrontierTable.writerEpoch,
        appliedSeq: SyncFrontierTable.appliedSeq,
      })
      .from(SyncFrontierTable)
      .where(eq(SyncFrontierTable.syncGenerationId, syncGenerationId)),
  ]);
  const applied = new Map(frontier.map((row) => [frontierLaneKey(row.writerId, row.writerEpoch), row.appliedSeq]));
  const newest = new Map<string, number>();
  for (const segment of segments) {
    const lane = frontierLaneKey(segment.writerId, segment.writerEpoch);
    newest.set(lane, Math.max(newest.get(lane) ?? 0, segment.lastSeq));
  }
  const quarantined = new Set(
    (
      await db
        .select({ localObjectId: SyncQuarantinedObjectTable.localObjectId })
        .from(SyncQuarantinedObjectTable)
        .where(eq(SyncQuarantinedObjectTable.syncGenerationId, syncGenerationId))
    ).map((row) => row.localObjectId),
  );
  const removable = segments.filter((segment) => {
    const lane = frontierLaneKey(segment.writerId, segment.writerEpoch);
    return (
      segment.removedAt !== null &&
      segment.lastSeq < (newest.get(lane) ?? 0) &&
      segment.lastSeq <= (applied.get(lane) ?? 0) &&
      !quarantined.has(segment.localObjectId)
    );
  });
  for (let offset = 0; offset < removable.length; offset += DELETE_BATCH) {
    const batch = removable.slice(offset, offset + DELETE_BATCH);
    const segmentIds = batch.map((segment) => segment.segmentId);
    const localObjectIds = batch.map((segment) => segment.localObjectId);
    await db.transaction(async (tx) => {
      await tx.delete(SyncSegmentTable).where(inArray(SyncSegmentTable.segmentId, segmentIds));
      // Any transfer of these objects is finished business: the provider no
      // longer holds them and the replica has applied their content.
      await tx.delete(SyncTransferTable).where(inArray(SyncTransferTable.localObjectId, localObjectIds));
      await tx.delete(SyncLocalObjectTable).where(inArray(SyncLocalObjectTable.id, localObjectIds));
    });
  }
  return removable.length;
}
