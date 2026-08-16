import type {
  SnapshotAssetCapturePort,
  SnapshotAssetRestorePort,
} from '../checkpoint';
import type {
  SyncAssetBlobDeclaration,
  SyncEngineBlobPort,
  VerifiedInboundSyncBlob,
} from '../engine/blob-port';
import { platform } from '../../platform';
import { nativeSyncObjectCodec, type NativeSyncObjectCodec } from '../native-object-codec';
import {
  createLocalObjectRef,
  sha256Bytes,
  type LocalObjectRef,
  type RemoteObject,
  type Sha256,
  type SnapshotAssetV1,
} from '../protocol';

export interface NativeVerifiedAssetSourceResult {
  readonly sourceRef: string;
  readonly blobId: string;
  readonly sourceSha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
}

export interface NativePreparedAssetSourceResult {
  readonly assetId: string;
  readonly stagingRef: string;
  readonly sourceSha256: string;
  readonly sizeBytes: number;
}

/** Native contract; all filesystem values crossing IPC are opaque syncobj refs. */
export interface NativeSyncAssetStorePort {
  captureSource(input: {
    projectId: string;
    assetId: string;
    expectedSourceSha256: Sha256;
    expectedSizeBytes: number;
    expectedMimeType: string;
  }): Promise<NativeVerifiedAssetSourceResult>;
  prepareRestoreSource(input: {
    attemptId: string;
    targetProjectId: string;
    assetId: string;
    blobId: Sha256;
    sourceRef: LocalObjectRef;
    expectedSourceSha256: Sha256;
    expectedSizeBytes: number;
    expectedMimeType: string;
  }): Promise<NativePreparedAssetSourceResult>;
  activateRestoreSources(input: {
    attemptId: string;
    targetProjectId: string;
    stagingRefs: readonly LocalObjectRef[];
  }): Promise<string>;
  abandonRestoreAttempt(attemptId: string): Promise<void>;
  finalizeRestoreAttempt(attemptId: string): Promise<void>;
  gcRestoreAttempts(input: {
    retainedAttemptIds: readonly string[];
    olderThanMs: number;
  }): Promise<{ removedAttempts: number }>;
}

function sha256(value: string, label: string): Sha256 {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} is not a protocol SHA-256`);
  }
  return value as Sha256;
}

function requireSafeSize(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is not a safe byte size`);
  }
}

function normalizedMime(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() ?? '';
}

function assertCapturedSource(
  result: NativeVerifiedAssetSourceResult,
  expected: {
    sourceSha256: Sha256;
    sizeBytes: number;
    mimeType: string;
  },
): { sourceRef: LocalObjectRef; blobId: Sha256; sourceSha256: Sha256 } {
  requireSafeSize(result.sizeBytes, 'native asset source size');
  const blobId = sha256(result.blobId, 'native asset blob ID');
  const sourceSha256 = sha256(result.sourceSha256, 'native asset source hash');
  if (
    blobId !== expected.sourceSha256 ||
    sourceSha256 !== expected.sourceSha256 ||
    result.sizeBytes !== expected.sizeBytes ||
    normalizedMime(result.mimeType) !== normalizedMime(expected.mimeType)
  ) {
    throw new Error('native canonical asset verification changed immutable metadata');
  }
  return {
    sourceRef: createLocalObjectRef(result.sourceRef),
    blobId,
    sourceSha256,
  };
}

export function createNativeSnapshotAssetCapturePort(
  native: NativeSyncAssetStorePort,
): SnapshotAssetCapturePort {
  return {
    async captureCanonicalSource(input) {
      const result = await native.captureSource(input);
      const verified = assertCapturedSource(result, {
        sourceSha256: input.expectedSourceSha256,
        sizeBytes: input.expectedSizeBytes,
        mimeType: input.expectedMimeType,
      });
      return {
        blobId: verified.blobId,
        sourceRef: verified.sourceRef,
        sourceSha256: verified.sourceSha256,
        sizeBytes: result.sizeBytes,
        mimeType: normalizedMime(result.mimeType),
      };
    },
  };
}

function restoreInput(
  attemptId: string,
  targetProjectId: string,
  asset: SnapshotAssetV1,
  sourceRef: LocalObjectRef,
) {
  return {
    attemptId,
    targetProjectId,
    assetId: asset.assetId,
    blobId: sha256(asset.blobId, 'snapshot asset blob ID'),
    sourceRef,
    expectedSourceSha256: asset.sourceSha256,
    expectedSizeBytes: asset.sizeBytes,
    expectedMimeType: asset.mimeType,
  };
}

export function createNativeSnapshotAssetRestorePort(
  native: NativeSyncAssetStorePort,
): SnapshotAssetRestorePort {
  return {
    async prepareVerifiedSource({ attemptId, targetProjectId, asset, sourceRef }) {
      const result = await native.prepareRestoreSource(
        restoreInput(attemptId, targetProjectId, asset, sourceRef),
      );
      requireSafeSize(result.sizeBytes, 'native prepared asset size');
      const sourceSha256 = sha256(result.sourceSha256, 'native prepared asset hash');
      if (
        result.assetId !== asset.assetId ||
        sourceSha256 !== asset.sourceSha256 ||
        result.sizeBytes !== asset.sizeBytes
      ) {
        throw new Error('native prepared asset does not match checkpoint metadata');
      }
      return {
        assetId: result.assetId,
        stagingRef: createLocalObjectRef(result.stagingRef),
        sourceSha256,
        sizeBytes: result.sizeBytes,
      };
    },
    activatePreparedSources: (input) => native.activateRestoreSources(input),
    finalizeAttempt: ({ attemptId }) => native.finalizeRestoreAttempt(attemptId),
    abandonAttempt: ({ attemptId }) => native.abandonRestoreAttempt(attemptId),
  };
}

function canonicalBlobLogicalKey(syncGenerationId: string, blobId: Sha256): string {
  return `blob/${syncGenerationId}/${blobId}`;
}

export function nativeBlobAttemptId(syncGenerationId: string, logicalKeyId: string): string {
  return `blob-install:${syncGenerationId}:${logicalKeyId}`;
}

function sameBlobDeclarations(
  declarations: readonly SyncAssetBlobDeclaration[],
  contentSha256: Sha256,
  contentSizeBytes: number,
): readonly SyncAssetBlobDeclaration[] {
  const matches = declarations.filter(
    (declaration) =>
      declaration.blobId === contentSha256 &&
      declaration.sourceSha256 === contentSha256,
  );
  if (matches.some((declaration) => declaration.sourceSizeBytes !== contentSizeBytes)) {
    throw new Error('asset bind metadata size conflicts with authenticated blob content');
  }
  return matches;
}

/** Production native plaintext implementation of the durable engine blob lane. */
export class NativeSyncAssetBlobPort implements SyncEngineBlobPort {
  constructor(
    private readonly nativeAssets: NativeSyncAssetStorePort,
    private readonly nativeObjects: NativeSyncObjectCodec,
  ) {}

  async prepareOutbound(input: {
    syncGenerationId: string;
    projectId: string;
    declaration: SyncAssetBlobDeclaration;
  }) {
    const captured = await this.nativeAssets.captureSource({
      projectId: input.projectId,
      assetId: input.declaration.assetId,
      expectedSourceSha256: input.declaration.sourceSha256,
      expectedSizeBytes: input.declaration.sourceSizeBytes,
      expectedMimeType: input.declaration.sourceMime,
    });
    const verified = assertCapturedSource(captured, {
      sourceSha256: input.declaration.sourceSha256,
      sizeBytes: input.declaration.sourceSizeBytes,
      mimeType: input.declaration.sourceMime,
    });
    const logicalKeyId = await sha256Bytes(
      new TextEncoder().encode(
        canonicalBlobLogicalKey(input.syncGenerationId, input.declaration.blobId),
      ),
    );
    return {
      sourceRef: verified.sourceRef,
      logicalKeyId,
      storedSha256: verified.sourceSha256,
      contentSha256: verified.sourceSha256,
      sizeBytes: captured.sizeBytes,
    };
  }

  async verifyAndInstallInbound(input: {
    syncGenerationId: string;
    projectId: string;
    remoteObject: RemoteObject;
    sourceRef: LocalObjectRef;
    declarations: readonly SyncAssetBlobDeclaration[];
  }): Promise<VerifiedInboundSyncBlob | null> {
    if (input.remoteObject.objectKind !== 'blob') {
      throw new Error('asset blob lane received a non-blob object');
    }
    const matching = sameBlobDeclarations(
      input.declarations,
      input.remoteObject.storedSha256,
      input.remoteObject.sizeBytes,
    );
    if (matching.length === 0) {
      await this.nativeObjects.discardLocal?.(input.sourceRef).catch(() => {});
      return null;
    }

    const attemptId = nativeBlobAttemptId(input.syncGenerationId, input.remoteObject.logicalKeyId);
    await this.nativeAssets.abandonRestoreAttempt(attemptId).catch(() => {});
    const stagingRefs: LocalObjectRef[] = [];
    try {
      for (const declaration of matching) {
        const prepared = await this.nativeAssets.prepareRestoreSource({
          attemptId,
          targetProjectId: input.projectId,
          assetId: declaration.assetId,
          blobId: declaration.blobId,
          sourceRef: input.sourceRef,
          expectedSourceSha256: declaration.sourceSha256,
          expectedSizeBytes: declaration.sourceSizeBytes,
          expectedMimeType: declaration.sourceMime,
        });
        if (
          prepared.assetId !== declaration.assetId ||
          sha256(prepared.sourceSha256, 'prepared inbound source hash') !==
            declaration.sourceSha256 ||
          prepared.sizeBytes !== declaration.sourceSizeBytes
        ) {
          throw new Error('native inbound asset staging changed immutable metadata');
        }
        stagingRefs.push(createLocalObjectRef(prepared.stagingRef));
      }
      await this.nativeAssets.activateRestoreSources({
        attemptId,
        targetProjectId: input.projectId,
        stagingRefs,
      });
    } catch (error) {
      await this.nativeAssets.abandonRestoreAttempt(attemptId).catch(() => {});
      await this.nativeObjects.discardLocal?.(input.sourceRef).catch(() => {});
      throw error;
    }
    await this.nativeObjects.discardLocal?.(input.sourceRef).catch(() => {});

    const installedAssetIds = Object.freeze(matching.map(({ assetId }) => assetId).sort());
    return Object.freeze({
      blobId: input.remoteObject.storedSha256,
      logicalKeyId: input.remoteObject.logicalKeyId,
      contentSha256: input.remoteObject.storedSha256,
      contentSizeBytes: input.remoteObject.sizeBytes,
      mimeType: normalizedMime(matching[0]!.sourceMime),
      installedAssetIds,
      commit: () => this.nativeAssets.finalizeRestoreAttempt(attemptId),
      rollback: () => this.nativeAssets.abandonRestoreAttempt(attemptId),
    });
  }
}

export const nativeSnapshotAssetCapturePort = createNativeSnapshotAssetCapturePort(
  platform.syncAssetStore,
);
export const nativeSnapshotAssetRestorePort = createNativeSnapshotAssetRestorePort(
  platform.syncAssetStore,
);
export const nativeSyncAssetBlobPort = new NativeSyncAssetBlobPort(
  platform.syncAssetStore,
  nativeSyncObjectCodec,
);
