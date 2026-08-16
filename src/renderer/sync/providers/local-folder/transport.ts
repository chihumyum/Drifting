import type {
  LocalObjectRef,
  ProviderObjectId,
  RemoteObject,
  RemoteObjectChange,
  Sha256,
  SyncObjectKind,
} from '../../protocol';

declare const localFolderTransportGenerationRefBrand: unique symbol;

/**
 * Root-confined SyncGeneration reference owned by the native/local transport.
 *
 * This is deliberately not a path. Renderer provider code must never receive
 * the selected folder path, an absolute source path, or raw transfer bytes.
 */
export type LocalFolderTransportGenerationRef = string & {
  readonly [localFolderTransportGenerationRefBrand]: true;
};

export function createLocalFolderTransportGenerationRef(value: string): LocalFolderTransportGenerationRef {
  if (!/^syncfolder:[A-Za-z0-9._~-]{2,512}$/u.test(value)) {
    throw new TypeError('Local-folder transport SyncGeneration references must be opaque syncfolder tokens');
  }
  return value as LocalFolderTransportGenerationRef;
}

export interface LocalFolderDurableChange {
  readonly revision: number;
  readonly change: RemoteObjectChange;
}

/**
 * Complete committed event catalog. Implementations must omit incomplete
 * staging directories and fail closed on malformed, duplicated, or gapped
 * revisions.
 */
export interface LocalFolderCatalogSnapshot {
  readonly latestRevision: number;
  readonly changes: readonly LocalFolderDurableChange[];
}

export interface LocalFolderTransportSyncGeneration {
  readonly generationRef: LocalFolderTransportGenerationRef;
  readonly syncGenerationId: string;
}

export interface LocalFolderCommitPresentResult {
  readonly status: 'created' | 'already-present';
  readonly object: RemoteObject;
}

export interface LocalFolderMaterializeResult {
  readonly destinationRef: LocalObjectRef;
  readonly storedSha256: Sha256;
  readonly sizeBytes: number;
}

/**
 * Native/local filesystem capability consumed by LocalFolderObjectLogProvider.
 *
 * The production implementation must resolve both `rootSecretRef` and every
 * `LocalObjectRef` inside native-owned, root-confined stores. `commitPresent`
 * is one durable operation: validate source size/hash, serialize writers,
 * enforce the historical immutable identity ledger, fsync staged bytes and
 * metadata, atomically rename the staged event directory, then fsync its
 * parent before resolving. `materializeVerified` must validate remote bytes
 * before atomically replacing the destination object. No method accepts a
 * filesystem path or a renderer byte array.
 */
export interface LocalFolderObjectTransportPort {
  openGeneration(input: {
    rootSecretRef: string;
    bindingId: string;
    syncGenerationId: string;
    authorityGeneration: number;
  }): Promise<LocalFolderTransportSyncGeneration>;

  readCatalog(generation: LocalFolderTransportSyncGeneration): Promise<LocalFolderCatalogSnapshot>;

  commitPresent(input: {
    generation: LocalFolderTransportSyncGeneration;
    sourceRef: LocalObjectRef;
    objectKind: SyncObjectKind;
    logicalKeyId: string;
    storedSha256: Sha256;
    sizeBytes: number;
    transferId: string;
    signal: AbortSignal;
  }): Promise<LocalFolderCommitPresentResult>;

  materializeVerified(input: {
    generation: LocalFolderTransportSyncGeneration;
    objectId: ProviderObjectId;
    destinationRef: LocalObjectRef;
    expectedStoredSha256: Sha256;
    transferId: string;
    signal: AbortSignal;
  }): Promise<LocalFolderMaterializeResult>;
}
