import { describe, expect, it, vi } from 'vitest';

import type { NativeSyncObjectCodec } from '../native-object-codec';
import {
  createLocalObjectRef,
  createProviderObjectId,
  type Sha256,
} from '../protocol';
import {
  createNativeSnapshotAssetCapturePort,
  createNativeSnapshotAssetRestorePort,
  NativeSyncAssetBlobPort,
  type NativeSyncAssetStorePort,
} from './native-asset-pipeline';

const SOURCE_SHA = `sha256:${'a'.repeat(64)}` as Sha256;
const LOGICAL_ID = `sha256:${'b'.repeat(64)}`;

function nativeAssets(): NativeSyncAssetStorePort & {
  captureSource: ReturnType<typeof vi.fn>;
  prepareRestoreSource: ReturnType<typeof vi.fn>;
  activateRestoreSources: ReturnType<typeof vi.fn>;
  abandonRestoreAttempt: ReturnType<typeof vi.fn>;
  finalizeRestoreAttempt: ReturnType<typeof vi.fn>;
} {
  return {
    captureSource: vi.fn(async () => ({
      sourceRef: 'syncobj:captured-source',
      blobId: SOURCE_SHA,
      sourceSha256: SOURCE_SHA,
      sizeBytes: 12,
      mimeType: 'application/pdf',
    })),
    prepareRestoreSource: vi.fn(async ({ assetId }) => ({
      assetId,
      stagingRef: `syncobj:staged-${assetId}`,
      sourceSha256: SOURCE_SHA,
      sizeBytes: 12,
    })),
    activateRestoreSources: vi.fn(async () => 'native-activation-receipt'),
    abandonRestoreAttempt: vi.fn(async () => {}),
    finalizeRestoreAttempt: vi.fn(async () => {}),
    gcRestoreAttempts: vi.fn(async () => ({ removedAttempts: 0 })),
  };
}

function nativeObjects(): NativeSyncObjectCodec {
  return {
    stageProtocolBytes: vi.fn(),
    readProtocolBytes: vi.fn(),
    stageAssetSource: vi.fn(),
    discardLocal: vi.fn(async () => {}),
  };
}

describe('native SyncEngine asset pipeline', () => {
  it('captures checkpoint sources through opaque refs and verifies all immutable metadata', async () => {
    const native = nativeAssets();
    const port = createNativeSnapshotAssetCapturePort(native);
    await expect(
      port.captureCanonicalSource({
        projectId: 'project-1',
        assetId: 'asset-1',
        expectedSourceSha256: SOURCE_SHA,
        expectedSizeBytes: 12,
        expectedMimeType: 'application/pdf',
      }),
    ).resolves.toEqual({
      blobId: SOURCE_SHA,
      sourceRef: 'syncobj:captured-source',
      sourceSha256: SOURCE_SHA,
      sizeBytes: 12,
      mimeType: 'application/pdf',
    });
    expect(native.captureSource).toHaveBeenCalledWith(
      expect.not.objectContaining({ bytes: expect.anything(), filePath: expect.anything() }),
    );

    native.captureSource.mockResolvedValueOnce({
      sourceRef: 'syncobj:captured-source',
      blobId: SOURCE_SHA,
      sourceSha256: SOURCE_SHA,
      sizeBytes: 13,
      mimeType: 'application/pdf',
    });
    await expect(
      port.captureCanonicalSource({
        projectId: 'project-1',
        assetId: 'asset-1',
        expectedSourceSha256: SOURCE_SHA,
        expectedSizeBytes: 12,
        expectedMimeType: 'application/pdf',
      }),
    ).rejects.toThrow(/immutable metadata/u);
  });

  it('keeps checkpoint restore staging restart-safe until SQLite calls finalize', async () => {
    const native = nativeAssets();
    const port = createNativeSnapshotAssetRestorePort(native);
    const prepared = await port.prepareVerifiedSource({
      attemptId: 'attempt-1',
      targetProjectId: 'project-1',
      sourceRef: createLocalObjectRef('syncobj:downloaded-source'),
      asset: {
        assetId: 'asset-1',
        blobId: SOURCE_SHA,
        sourceSha256: SOURCE_SHA,
        sizeBytes: 12,
        mimeType: 'application/pdf',
      },
    });
    await expect(
      port.activatePreparedSources({
        attemptId: 'attempt-1',
        targetProjectId: 'project-1',
        stagingRefs: [prepared.stagingRef],
      }),
    ).resolves.toBe('native-activation-receipt');
    expect(native.finalizeRestoreAttempt).not.toHaveBeenCalled();
    await port.finalizeAttempt?.({ attemptId: 'attempt-1' });
    expect(native.finalizeRestoreAttempt).toHaveBeenCalledWith('attempt-1');
  });

  it('installs provider-verified inbound blobs before exposing a commit callback', async () => {
    const native = nativeAssets();
    const port = new NativeSyncAssetBlobPort(native, nativeObjects());
    const verified = await port.verifyAndInstallInbound({
      syncGenerationId: 'sync-generation-1',
      projectId: 'project-1',
      remoteObject: {
        objectId: createProviderObjectId('remote-blob-1'),
        objectKind: 'blob',
        logicalKeyId: LOGICAL_ID,
        storedSha256: SOURCE_SHA,
        sizeBytes: 12,
      },
      sourceRef: createLocalObjectRef('syncobj:downloaded-blob'),
      declarations: [{
        assetId: 'asset-1',
        blobId: SOURCE_SHA,
        sourceSha256: SOURCE_SHA,
        sourceSizeBytes: 12,
        sourceMime: 'application/pdf',
      }],
    });
    expect(verified).not.toBeNull();
    expect(native.prepareRestoreSource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRef: 'syncobj:downloaded-blob',
        expectedSourceSha256: SOURCE_SHA,
      }),
    );
    expect(native.prepareRestoreSource).toHaveBeenCalledWith(
      expect.not.objectContaining({ bytes: expect.anything(), filePath: expect.anything() }),
    );
    expect(native.activateRestoreSources).toHaveBeenCalledOnce();
    expect(native.finalizeRestoreAttempt).not.toHaveBeenCalled();
    await verified!.commit();
    expect(native.finalizeRestoreAttempt).toHaveBeenCalledOnce();
  });
});
