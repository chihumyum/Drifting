import type { DbExecutor, DbTransaction } from '../../lib/db';
import type {
  CanonicalCborValue,
  LocalObjectRef,
  Sha256,
  SnapshotAssetV1,
  SnapshotCommitMarkerV1,
  SnapshotKind,
  SnapshotPackageV1,
} from '../protocol';
import type { SyncWriterIdentitySource } from '../journal/writer-state';

export const AUTHORED_STATE_FORMAT_V1 = 'drifting.sync.authored-state' as const;
export const REDUCER_STATE_FORMAT_V1 = 'drifting.sync.reducer-state' as const;

export interface SnapshotTableRowsV1 {
  readonly table: string;
  readonly rows: readonly Readonly<Record<string, CanonicalCborValue>>[];
}

export interface AuthoredStatePayloadV1 {
  readonly format: typeof AUTHORED_STATE_FORMAT_V1;
  readonly payloadVersion: 1;
  readonly tables: readonly SnapshotTableRowsV1[];
}

export interface ReducerStatePayloadV1 {
  readonly format: typeof REDUCER_STATE_FORMAT_V1;
  readonly payloadVersion: 1;
  readonly changeSets: readonly Readonly<Record<string, CanonicalCborValue>>[];
  readonly mutations: readonly Readonly<Record<string, CanonicalCborValue>>[];
  readonly applyReceipts: readonly Readonly<Record<string, CanonicalCborValue>>[];
  readonly generationPurges: readonly Readonly<Record<string, CanonicalCborValue>>[];
  readonly fieldClocks: readonly Readonly<Record<string, CanonicalCborValue>>[];
  readonly setTags: readonly Readonly<Record<string, CanonicalCborValue>>[];
  readonly orderRegisters: readonly Readonly<Record<string, CanonicalCborValue>>[];
  readonly lifecycles: readonly Readonly<Record<string, CanonicalCborValue>>[];
  readonly frontier: readonly Readonly<Record<string, CanonicalCborValue>>[];
}

export interface CapturedAssetSourceV1 {
  readonly asset: SnapshotAssetV1;
  readonly sourceRef: LocalObjectRef;
}

export interface CapturedSnapshotV1 {
  readonly package: SnapshotPackageV1;
  readonly packageBytes: Uint8Array;
  readonly packageSha256: Sha256;
  readonly commitMarker: SnapshotCommitMarkerV1;
  readonly commitMarkerBytes: Uint8Array;
  readonly assets: readonly CapturedAssetSourceV1[];
}

export interface SnapshotAssetCapturePort {
  captureCanonicalSource(input: {
    projectId: string;
    assetId: string;
    expectedSourceSha256: Sha256;
    expectedSizeBytes: number;
    expectedMimeType: string;
  }): Promise<{
    blobId: string;
    sourceRef: LocalObjectRef;
    sourceSha256: Sha256;
    sizeBytes: number;
    mimeType: string;
  }>;
}

export interface SnapshotPublishPort {
  ensureBlob(input: CapturedAssetSourceV1): Promise<void>;
  publishPackage(input: {
    snapshotKind: SnapshotKind;
    snapshotId: string;
    logicalKeyId: string;
    bytes: Uint8Array;
    sha256: Sha256;
  }): Promise<void>;
  publishCommitMarker(input: {
    snapshotKind: SnapshotKind;
    snapshotId: string;
    bytes: Uint8Array;
  }): Promise<void>;
}

export interface SnapshotAssetRestorePort {
  prepareVerifiedSource(input: {
    attemptId: string;
    targetProjectId: string;
    asset: SnapshotAssetV1;
    sourceRef: LocalObjectRef;
  }): Promise<{
    assetId: string;
    stagingRef: LocalObjectRef;
    sourceSha256: Sha256;
    sizeBytes: number;
  }>;
  activatePreparedSources(input: {
    attemptId: string;
    targetProjectId: string;
    stagingRefs: readonly LocalObjectRef[];
  }): Promise<string>;
  /** Called only after the SQLite activation transaction commits. */
  finalizeAttempt?(input: { attemptId: string }): Promise<void>;
  abandonAttempt(input: { attemptId: string; stagingRefs: readonly LocalObjectRef[] }): Promise<void>;
}

export interface RestoreSnapshotInputV1 {
  readonly db: DbExecutor;
  readonly attemptId: string;
  readonly stagingRef: LocalObjectRef;
  /** Durable package object metadata from the provider inbox. */
  readonly packageObject?: {
    readonly storedSha256: Sha256;
    readonly sizeBytes: number;
  };
  readonly expected: {
    readonly projectId: string;
    readonly projectSyncId: string;
    readonly syncGenerationId: string;
  };
  readonly localUserId: string;
  /** Current native installation; restore creates a fresh writer at sequence 1. */
  readonly writerIdentity: SyncWriterIdentitySource;
  readonly packageBytes: Uint8Array;
  readonly commitMarkerBytes: Uint8Array;
  readonly blobSources: ReadonlyMap<string, LocalObjectRef>;
  /** Provider-visible keyed identity for each content-addressed blob. */
  readonly blobLogicalKeyIds?: ReadonlyMap<string, string>;
  readonly assetPort: SnapshotAssetRestorePort;
  readonly nowIso?: () => string;
}

export type RestoreFailureCode =
  | 'unknown-version'
  | 'invalid-marker'
  | 'invalid-package'
  | 'identity-mismatch'
  | 'schema-mismatch'
  | 'reference-invalid'
  | 'invalid-yjs'
  | 'missing-blob'
  | 'corrupt-blob'
  | 'target-exists'
  | 'sync-generation-not-staged'
  | 'activation-failed';

export class SnapshotRestoreError extends Error {
  constructor(
    readonly code: RestoreFailureCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SnapshotRestoreError';
  }
}

export interface RestoreSnapshotResultV1 {
  readonly attemptId: string;
  readonly projectId: string;
  readonly syncGenerationId: string;
  readonly snapshotId: string;
  readonly activationReceipt: string;
}

export interface RestoreSnapshotsAtomicallyInputV1 {
  /** Every item must use the same SQLite client. */
  readonly snapshots: readonly RestoreSnapshotInputV1[];
  /**
   * Optional App-wide activation barrier. It runs after every project is
   * materialized but before the same SQLite transaction commits.
   */
  readonly activationBarrier?: (input: {
    tx: DbTransaction;
    results: readonly RestoreSnapshotResultV1[];
    activatedAt: string;
  }) => Promise<void>;
}
