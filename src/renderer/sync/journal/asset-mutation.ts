import type { ProjectAsset } from '../../domain/project-asset';
import type { ProjectAssetOwnerV1 } from '../protocol';
import type { SyncChangeBuilder } from './change-builder';

export type ProjectAssetOwner = ProjectAssetOwnerV1;

function assertOwner(owner: ProjectAssetOwner): void {
  if (!owner.id.trim()) throw new TypeError('project asset owner id is required');
}

function wireSha256(sourceSha256: string): `sha256:${string}` {
  if (!/^[0-9a-f]{64}$/u.test(sourceSha256)) {
    throw new TypeError('project asset sourceSha256 must be 64 lowercase hexadecimal characters');
  }
  return `sha256:${sourceSha256}`;
}

/**
 * Record immutable asset metadata and its single owner in the same change-set
 * as the domain row writes. The source blob must be published before a segment
 * containing this mutation becomes visible remotely.
 */
export function appendProjectAssetBindMutation(
  changes: SyncChangeBuilder,
  projectId: string,
  asset: ProjectAsset,
  owner: ProjectAssetOwner,
): string {
  if (asset.projectId !== projectId) {
    throw new Error(`project asset ${asset.id} does not belong to project ${projectId}`);
  }
  assertOwner(owner);
  const sourceSha256 = wireSha256(asset.sourceSha256);
  changes.add({
    action: 'asset.bind',
    target: {
      family: 'asset',
      kind: 'project-asset',
      id: asset.id,
      incarnation: 0,
    },
    payload: {
      blobId: sourceSha256,
      sourceSha256,
      sourceMime: asset.sourceMime,
      sourceSizeBytes: asset.sourceSizeBytes,
      kind: asset.kind,
      width: asset.width,
      height: asset.height,
      createdAt: asset.createdAt,
      owner: { ...owner },
    },
  });
  return sourceSha256;
}

/** Unbind the only owner. v1 intentionally does not request remote blob GC. */
export function appendProjectAssetUnbindMutation(
  changes: SyncChangeBuilder,
  assetId: string,
  owner: ProjectAssetOwner,
): void {
  if (!assetId.trim()) throw new TypeError('project asset id is required');
  assertOwner(owner);
  changes.add({
    action: 'asset.unbind',
    target: {
      family: 'asset',
      kind: 'project-asset',
      id: assetId,
      incarnation: 0,
    },
    payload: { owner: { ...owner } },
  });
}
