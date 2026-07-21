import type { AssetUploadJob, AssetUploadStage } from '../domain/asset-upload-job';

export type AssetUploadRecoveryAction =
  | 'prepare'
  | 'create_asset'
  | 'try_complete'
  | 'bind'
  | 'cleanup';

const ALLOWED_TRANSITIONS: Record<AssetUploadStage, ReadonlySet<AssetUploadStage>> = {
  queued: new Set(['preparing', 'canceled']),
  preparing: new Set(['preparing', 'cached', 'canceled']),
  cached: new Set(['cached', 'uploading', 'binding', 'canceled']),
  uploading: new Set(['cached', 'uploading', 'completing', 'binding', 'canceled']),
  completing: new Set(['cached', 'completing', 'binding', 'canceled']),
  binding: new Set(['binding', 'cleanup', 'canceled']),
  cleanup: new Set(['cleanup', 'canceled']),
  canceled: new Set(['canceled']),
};

export function assertAssetUploadTransition(from: AssetUploadStage, to: AssetUploadStage): void {
  if (!ALLOWED_TRANSITIONS[from].has(to)) {
    throw new Error(`Invalid asset upload transition: ${from} -> ${to}`);
  }
}

/** Decide the first idempotent operation after startup or an explicit retry. */
export function assetUploadRecoveryAction(job: AssetUploadJob): AssetUploadRecoveryAction {
  if (job.stage === 'canceled' || job.stage === 'cleanup') return 'cleanup';
  if (job.stage === 'queued' || job.stage === 'preparing') return 'prepare';
  if (job.stage === 'cached') return 'create_asset';
  if (job.stage === 'binding') return job.assetId ? 'bind' : 'create_asset';
  return job.assetId ? 'try_complete' : 'create_asset';
}

/**
 * A pending asset gets one conservative complete retry. Only a job that had
 * already failed before this run may reopen its stable upload id and request
 * fresh presigned URLs, which protects the "remote PUT succeeded but response
 * was lost" case.
 */
export function shouldRefreshIncompleteUpload(job: AssetUploadJob): boolean {
  return Boolean(
    job.lastError && job.assetId && (job.stage === 'uploading' || job.stage === 'completing'),
  );
}

/** A successful job cache is already canonical because uploadId === job.id. */
export function shouldDeleteAssetUploadCache(stage: AssetUploadStage): boolean {
  return stage === 'canceled';
}
