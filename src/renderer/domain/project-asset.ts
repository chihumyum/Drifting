export type ProjectAssetKind = 'image';
export type ProjectAssetRole = 'element_portrait';
export type ProjectAssetOwnerKind = 'element';
export type ProjectAssetStatus = 'pending' | 'ready' | 'failed';

export interface ProjectAsset {
  id: string;
  projectId: string;
  kind: ProjectAssetKind;
  role: ProjectAssetRole;
  ownerKind: ProjectAssetOwnerKind;
  ownerId: string;
  status: ProjectAssetStatus;
  displayObjectKey: string;
  thumbnailObjectKey: string;
  sourceMime: string | null;
  displayMime: string;
  thumbnailMime: string;
  sourceSizeBytes: number | null;
  displaySizeBytes: number | null;
  thumbnailSizeBytes: number | null;
  width: number | null;
  height: number | null;
  completedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
