import type { DbClient } from '../lib/db';
import { SyncLocalObjectTable } from '../schema/drizzle';
import { compareUtf8Bytewise } from './protocol';

export interface NativeSyncObjectGcPort {
  gcOrphans(input: {
    retainedSourceRefs: readonly string[];
    olderThanMs: number;
  }): Promise<{ removedObjects: number; removedTemporaryFiles: number }>;
}

/**
 * Reconciles the native opaque-object directory against SQLite authority.
 *
 * The native side independently validates the managed root, canonical bucket
 * layout, entry names, symlinks and age threshold before deleting anything.
 */
export async function reconcileNativeSyncObjects(input: {
  db: DbClient;
  native: NativeSyncObjectGcPort;
  orphanAgeMs?: number;
}): Promise<{ removedObjects: number; removedTemporaryFiles: number }> {
  const rows = await input.db
    .select({ storageRef: SyncLocalObjectTable.storageRef })
    .from(SyncLocalObjectTable);
  const retainedSourceRefs = [...new Set(rows.map((row) => row.storageRef))].sort(
    compareUtf8Bytewise,
  );
  return input.native.gcOrphans({
    retainedSourceRefs,
    olderThanMs: input.orphanAgeMs ?? 24 * 60 * 60 * 1_000,
  });
}
