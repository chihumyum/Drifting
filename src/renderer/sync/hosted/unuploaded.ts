import { and, count, eq, gt, inArray, max, ne } from 'drizzle-orm';

import type { DbClient } from '../../lib/db';
import {
  SyncBlobStateTable,
  SyncChangeSetTable,
  SyncGenerationWriterStateTable,
  SyncProviderBindingTable,
  SyncSegmentTable,
} from '../../schema/drizzle';

/**
 * Changes only this Mac holds: this installation's local change sets that no
 * published segment covers yet, plus verified asset blobs the provider does
 * not have. Disconnecting before they upload leaves them on this Mac alone.
 */
export async function countUnuploadedLocalChanges(
  db: DbClient,
  installationId: string,
): Promise<number> {
  const lanes = await db
    .select({
      syncGenerationId: SyncGenerationWriterStateTable.syncGenerationId,
      writerId: SyncGenerationWriterStateTable.writerId,
      writerEpoch: SyncGenerationWriterStateTable.writerEpoch,
    })
    .from(SyncGenerationWriterStateTable)
    .innerJoin(
      SyncProviderBindingTable,
      eq(SyncProviderBindingTable.syncGenerationId, SyncGenerationWriterStateTable.syncGenerationId),
    )
    .where(
      and(
        eq(SyncGenerationWriterStateTable.installationId, installationId),
        ne(SyncProviderBindingTable.state, 'purged'),
      ),
    );
  let total = 0;
  for (const lane of lanes) {
    const [published] = await db
      .select({ lastSeq: max(SyncSegmentTable.lastSeq) })
      .from(SyncSegmentTable)
      .where(
        and(
          eq(SyncSegmentTable.syncGenerationId, lane.syncGenerationId),
          eq(SyncSegmentTable.writerId, lane.writerId),
          eq(SyncSegmentTable.writerEpoch, lane.writerEpoch),
          eq(SyncSegmentTable.state, 'published'),
        ),
      );
    const [pending] = await db
      .select({ value: count() })
      .from(SyncChangeSetTable)
      .where(
        and(
          eq(SyncChangeSetTable.syncGenerationId, lane.syncGenerationId),
          eq(SyncChangeSetTable.origin, 'local'),
          eq(SyncChangeSetTable.writerId, lane.writerId),
          eq(SyncChangeSetTable.writerEpoch, lane.writerEpoch),
          gt(SyncChangeSetTable.deviceSeq, published?.lastSeq ?? 0),
        ),
      );
    total += Number(pending?.value ?? 0);
  }
  const [blobs] = await db
    .select({ value: count() })
    .from(SyncBlobStateTable)
    .innerJoin(
      SyncProviderBindingTable,
      eq(SyncProviderBindingTable.syncGenerationId, SyncBlobStateTable.syncGenerationId),
    )
    .where(
      and(
        ne(SyncProviderBindingTable.state, 'purged'),
        eq(SyncBlobStateTable.localState, 'verified'),
        inArray(SyncBlobStateTable.remoteState, ['missing', 'publishing']),
      ),
    );
  return total + Number(blobs?.value ?? 0);
}
