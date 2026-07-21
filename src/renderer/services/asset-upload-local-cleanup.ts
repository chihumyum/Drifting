import type { AssetUploadJob } from '../domain/asset-upload-job';
import { platform } from '../platform';
import { assetCacheService } from './asset-cache.service';
import { shouldDeleteAssetUploadCache } from './asset-upload-state-machine';

type LocalCleanupJob = Pick<AssetUploadJob, 'id' | 'projectId' | 'sourcePath' | 'stage'>;

export type AssetUploadLocalCleanupDependencies = {
  deleteCache(projectId: string, assetId: string): Promise<void>;
  deleteImport(filePath: string): Promise<{ ok: true } | { ok: false; error: string }>;
};

const defaultDependencies: AssetUploadLocalCleanupDependencies = {
  deleteCache: (projectId, assetId) => assetCacheService.deleteAsset(projectId, assetId),
  deleteImport: (filePath) => platform.material.deleteImport(filePath),
};

/**
 * Remove only files that are no longer needed by the durable job.
 *
 * A successful job uses `job.id` as the canonical asset id, so its cache must
 * survive. A canceled job has no consumer and removes both cache and import.
 * The caller deletes the job row only after this function succeeds, making a
 * native cleanup failure resumable.
 */
export async function cleanupAssetUploadLocalFiles(
  job: LocalCleanupJob,
  dependencies: AssetUploadLocalCleanupDependencies = defaultDependencies,
): Promise<void> {
  if (shouldDeleteAssetUploadCache(job.stage)) {
    await dependencies.deleteCache(job.projectId, job.id);
  }
  const deletedImport = await dependencies.deleteImport(job.sourcePath);
  if (!deletedImport.ok) throw new Error(deletedImport.error);
}
