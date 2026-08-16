import { eq, inArray } from 'drizzle-orm';

import type { DbClient } from '../../lib/db';
import {
  SyncBlobStateTable,
  SyncRestoreAttemptTable,
} from '../../schema/drizzle';
import {
  nativeBlobAttemptId,
  type NativeSyncAssetStorePort,
} from './native-asset-pipeline';

const ACTIVE_RESTORE_STATES = [
  'downloading',
  'validating',
  'staging-assets',
  'activating',
] as const;

/**
 * Reconcile native attempt receipts before SyncEngine scheduling starts.
 *
 * Completed SQLite receipts preserve canonical sources and only finalize
 * staging. Interrupted attempts have no visible project transaction, so their
 * activated files are rolled back before the attempt is marked failed.
 */
export async function reconcileNativeSyncAssetAttempts(input: {
  db: DbClient;
  native: NativeSyncAssetStorePort;
  nowIso?: () => string;
  orphanAgeMs?: number;
}): Promise<{ interruptedAttempts: number; retainedNativeAttempts: number }> {
  const now = input.nowIso ?? (() => new Date().toISOString());
  const attempts = await input.db.select().from(SyncRestoreAttemptTable);
  const retained = new Set<string>();
  let interruptedAttempts = 0;

  for (const attempt of attempts) {
    if (attempt.state === 'completed') {
      try {
        await input.native.finalizeRestoreAttempt(attempt.attemptId);
      } catch {
        retained.add(attempt.attemptId);
      }
      continue;
    }
    if ((ACTIVE_RESTORE_STATES as readonly string[]).includes(attempt.state)) {
      try {
        await input.native.abandonRestoreAttempt(attempt.attemptId);
      } catch {
        retained.add(attempt.attemptId);
        continue;
      }
      const failedAt = now();
      await input.db
        .update(SyncRestoreAttemptTable)
        .set({
          state: 'failed',
          errorCode: 'interrupted-native-activation',
          updatedAt: failedAt,
          completedAt: failedAt,
        })
        .where(eq(SyncRestoreAttemptTable.attemptId, attempt.attemptId));
      interruptedAttempts += 1;
      continue;
    }
    try {
      await input.native.abandonRestoreAttempt(attempt.attemptId);
    } catch {
      retained.add(attempt.attemptId);
    }
  }

  const verifiedBlobs = await input.db
    .select({
      syncGenerationId: SyncBlobStateTable.syncGenerationId,
      logicalKeyId: SyncBlobStateTable.logicalKeyId,
    })
    .from(SyncBlobStateTable)
    .where(inArray(SyncBlobStateTable.localState, ['verified']));
  for (const blob of verifiedBlobs) {
    const attemptId = nativeBlobAttemptId(blob.syncGenerationId, blob.logicalKeyId);
    try {
      await input.native.finalizeRestoreAttempt(attemptId);
    } catch {
      retained.add(attemptId);
    }
  }

  await input.native.gcRestoreAttempts({
    retainedAttemptIds: [...retained],
    olderThanMs: input.orphanAgeMs ?? 24 * 60 * 60 * 1_000,
  });
  return {
    interruptedAttempts,
    retainedNativeAttempts: retained.size,
  };
}
