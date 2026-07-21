import { describe, expect, it } from 'vitest';
import type { AssetUploadJob } from '../domain/asset-upload-job';
import {
  assertAssetUploadTransition,
  assetUploadRecoveryAction,
  shouldDeleteAssetUploadCache,
  shouldRefreshIncompleteUpload,
} from './asset-upload-state-machine';

function job(patch: Partial<AssetUploadJob> = {}): AssetUploadJob {
  return {
    id: 'job-1',
    projectId: 'project-1',
    ownerKind: 'library_item',
    ownerId: 'material-1',
    kind: 'image',
    role: 'library_material',
    stage: 'queued',
    sourcePath: '/app/imports/source.png',
    sourceMime: null,
    sourceSizeBytes: null,
    displayMime: null,
    displaySizeBytes: null,
    thumbnailMime: null,
    thumbnailSizeBytes: null,
    width: null,
    height: null,
    assetId: null,
    previousAssetId: null,
    deletePreviousAssetOnCancel: false,
    attemptCount: 0,
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('asset upload state machine', () => {
  it('resumes preparation and fresh asset creation from durable stages', () => {
    expect(assetUploadRecoveryAction(job({ stage: 'queued' }))).toBe('prepare');
    expect(assetUploadRecoveryAction(job({ stage: 'preparing', lastError: 'interrupted' }))).toBe(
      'prepare',
    );
    expect(assetUploadRecoveryAction(job({ stage: 'cached' }))).toBe('create_asset');
  });

  it('tries complete before replacing an interrupted server asset', () => {
    expect(assetUploadRecoveryAction(job({ stage: 'uploading', assetId: 'asset-1' }))).toBe(
      'try_complete',
    );
    expect(assetUploadRecoveryAction(job({ stage: 'completing', assetId: 'asset-1' }))).toBe(
      'try_complete',
    );
    expect(assetUploadRecoveryAction(job({ stage: 'uploading', assetId: null }))).toBe(
      'create_asset',
    );
  });

  it('models crashes after prepare, create, and a partial PUT without reusing a URL', () => {
    // prepare committed all derived files under the stable job id; no server id
    // exists yet, so restart allocates a fresh asset.
    expect(assetUploadRecoveryAction(job({ stage: 'cached', assetId: null }))).toBe('create_asset');
    // create committed the server id but the process died before/during PUT.
    const afterCreate = job({ stage: 'uploading', assetId: 'asset-1', lastError: null });
    expect(assetUploadRecoveryAction(afterCreate)).toBe('try_complete');
    expect(shouldRefreshIncompleteUpload(afterCreate)).toBe(false);
    // Once that conservative complete probe has failed, the next run reopens
    // the stable upload id/object keys and obtains fresh presigned URLs.
    expect(
      shouldRefreshIncompleteUpload({ ...afterCreate, lastError: 'source upload missing' }),
    ).toBe(true);
  });

  it('keeps binding and cleanup idempotent after a restart', () => {
    expect(assetUploadRecoveryAction(job({ stage: 'binding', assetId: 'asset-1' }))).toBe('bind');
    expect(assetUploadRecoveryAction(job({ stage: 'cleanup', assetId: 'asset-1' }))).toBe(
      'cleanup',
    );
    expect(assetUploadRecoveryAction(job({ stage: 'canceled', assetId: 'asset-1' }))).toBe(
      'cleanup',
    );
  });

  it('binds a ready asset returned by an idempotent create retry without another PUT', () => {
    expect(() => assertAssetUploadTransition('cached', 'binding')).not.toThrow();
  });

  it('retains the canonical cache after success and deletes it after cancellation', () => {
    expect(shouldDeleteAssetUploadCache('cleanup')).toBe(false);
    expect(shouldDeleteAssetUploadCache('canceled')).toBe(true);
  });

  it('rejects transitions that could bind before completion', () => {
    expect(() => assertAssetUploadTransition('queued', 'binding')).toThrow(/queued -> binding/);
    expect(() => assertAssetUploadTransition('cached', 'cleanup')).toThrow(/cached -> cleanup/);
    expect(() => assertAssetUploadTransition('completing', 'binding')).not.toThrow();
    expect(() => assertAssetUploadTransition('binding', 'cleanup')).not.toThrow();
  });
});
