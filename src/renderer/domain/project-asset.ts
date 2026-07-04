export type ProjectAssetKind = 'image' | 'pdf';
export type ProjectAssetRole = 'element_portrait' | 'library_material';
export type ProjectAssetOwnerKind = 'element' | 'library_item';
export type ProjectAssetStatus = 'pending' | 'ready' | 'failed';

export interface ProjectAsset {
  id: string;
  projectId: string;
  kind: ProjectAssetKind;
  role: ProjectAssetRole;
  ownerKind: ProjectAssetOwnerKind;
  ownerId: string;
  status: ProjectAssetStatus;
  sourceObjectKey: string | null;
  displayObjectKey: string | null;
  thumbnailObjectKey: string | null;
  sourceMime: string | null;
  displayMime: string | null;
  thumbnailMime: string | null;
  sourceSizeBytes: number | null;
  displaySizeBytes: number | null;
  thumbnailSizeBytes: number | null;
  sourceSha256: string | null;
  width: number | null;
  height: number | null;
  completedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
