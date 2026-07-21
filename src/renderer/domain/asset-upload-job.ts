import type { ProjectAssetKind, ProjectAssetOwnerKind, ProjectAssetRole } from './project-asset';

/**
 * Durable, device-local workflow for uploading a project asset.
 *
 * Presigned URLs are deliberately absent: every upload attempt obtains fresh
 * URLs from the API, while the app-owned source/derived cache survives a
 * renderer or process restart.
 */
export type AssetUploadStage =
  | 'queued'
  | 'preparing'
  | 'cached'
  | 'uploading'
  | 'completing'
  | 'binding'
  | 'cleanup'
  | 'canceled';

export interface AssetUploadJob {
  id: string;
  projectId: string;
  ownerKind: ProjectAssetOwnerKind;
  ownerId: string;
  kind: ProjectAssetKind;
  role: ProjectAssetRole;
  stage: AssetUploadStage;
  /** App-owned import path returned by the native picker. */
  sourcePath: string;
  sourceMime: string | null;
  sourceSizeBytes: number | null;
  displayMime: string | null;
  displaySizeBytes: number | null;
  thumbnailMime: string | null;
  thumbnailSizeBytes: number | null;
  width: number | null;
  height: number | null;
  /** Current server-side pending/ready asset. Never a presigned URL. */
  assetId: string | null;
  /** Replaced portrait, deleted only after the new ready asset is bound. */
  previousAssetId: string | null;
  /** Hard owner/portrait deletion also reclaims the previously bound asset. */
  deletePreviousAssetOnCancel: boolean;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AssetUploadUiState = { state: 'uploading' } | { state: 'failed'; error: string };
