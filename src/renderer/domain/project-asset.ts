export type ProjectAssetKind = 'image' | 'pdf';
export type ProjectAssetVariant = 'source' | 'display' | 'thumbnail';

/**
 * Immutable metadata for one app-owned binary source.
 *
 * Owner bindings live on `element.portraitAssetId` and
 * `library_item.assetId`. Cloud object ids, revisions, delivery state, and
 * rebuildable derivative metadata belong to their respective local-store or
 * SyncEngine layers, not this authored row.
 */
export interface ProjectAsset {
  id: string;
  projectId: string;
  kind: ProjectAssetKind;
  sourceMime: string;
  sourceSizeBytes: number;
  sourceSha256: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}
