import { getDbIfInitialized } from '../lib/db';
import { platform } from '../platform';
import { ProjectAssetTable } from '../schema/drizzle';
import { flushPendingAssetPersistence } from './asset-store.service';

let startupRun: Promise<{ removedOrphans: number; clearedCommittedMarkers: number }> | null = null;

export async function runAssetStoreInventoryGc(): Promise<{
  removedOrphans: number;
  clearedCommittedMarkers: number;
}> {
  const database = getDbIfInitialized();
  if (!database) return Promise.reject(new Error('Database is not ready for asset cleanup'));
  await flushPendingAssetPersistence();
  const retainedAssets = await database
    .select({ projectId: ProjectAssetTable.projectId, assetId: ProjectAssetTable.id })
    .from(ProjectAssetTable);
  return platform.assetStore.gcOrphanImports(retainedAssets);
}

/**
 * Reconcile only current-format imports bearing the durable v1 marker.
 *
 * Native code distinguishes this process's active imports from markers left by
 * a terminated process. SQLite supplies the retained set; unmarked legacy or
 * unknown directories are never guessed at or deleted.
 */
export function runAssetStoreRestartGc(): Promise<{
  removedOrphans: number;
  clearedCommittedMarkers: number;
}> {
  if (startupRun) return startupRun;
  startupRun = runAssetStoreInventoryGc().catch((error) => {
    startupRun = null;
    throw error;
  });
  return startupRun;
}
