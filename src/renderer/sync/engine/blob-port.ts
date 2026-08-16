import type {
  LocalObjectRef,
  RemoteObject,
  Sha256,
} from '../protocol';

export interface SyncAssetBlobDeclaration {
  readonly assetId: string;
  readonly blobId: Sha256;
  readonly sourceSha256: Sha256;
  readonly sourceSizeBytes: number;
  readonly sourceMime: string;
}

export interface PreparedOutboundSyncBlob {
  readonly sourceRef: LocalObjectRef;
  readonly logicalKeyId: string;
  readonly storedSha256: Sha256;
  readonly contentSha256: Sha256;
  readonly sizeBytes: number;
}

export interface VerifiedInboundSyncBlob {
  readonly blobId: Sha256;
  readonly logicalKeyId: string;
  readonly contentSha256: Sha256;
  readonly contentSizeBytes: number;
  readonly mimeType: string;
  readonly installedAssetIds: readonly string[];
  /** Remove only native staging receipts after the SQLite verified receipt commits. */
  commit(): Promise<void>;
  /** Roll back native activation if SQLite cannot record the verified blob. */
  rollback(): Promise<void>;
}

/**
 * Streaming asset lane owned by native production adapters.
 *
 * Implementations may use in-memory bytes for Memory/LocalFolder conformance,
 * but Drive composition must use opaque native refs and streaming I/O.
 */
export interface SyncEngineBlobPort {
  prepareOutbound(input: {
    readonly syncGenerationId: string;
    readonly projectId: string;
    readonly declaration: SyncAssetBlobDeclaration;
  }): Promise<PreparedOutboundSyncBlob>;

  verifyAndInstallInbound(input: {
    readonly syncGenerationId: string;
    readonly projectId: string;
    readonly remoteObject: RemoteObject;
    readonly sourceRef: LocalObjectRef;
    readonly declarations: readonly SyncAssetBlobDeclaration[];
  }): Promise<VerifiedInboundSyncBlob | null>;
}
