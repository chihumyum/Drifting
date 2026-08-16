import type {
  LocalObjectRef,
  ProviderCursor,
  ProviderObjectId,
  ProviderPageToken,
  RemoteObject,
  RemoteObjectChange,
  Sha256,
  SyncObjectKind,
} from '../../protocol';

declare const googleDriveTransportGenerationRefBrand: unique symbol;

/** Native-owned Google credential + appDataFolder SyncGeneration reference. */
export type GoogleDriveTransportGenerationRef = string & {
  readonly [googleDriveTransportGenerationRefBrand]: true;
};

export function createGoogleDriveTransportGenerationRef(value: string): GoogleDriveTransportGenerationRef {
  if (!/^syncdrive:[A-Za-z0-9._~-]{2,512}$/u.test(value)) {
    throw new TypeError('Google Drive transport SyncGeneration references must be opaque syncdrive tokens');
  }
  return value as GoogleDriveTransportGenerationRef;
}

export interface GoogleDriveTransportSyncGeneration {
  readonly generationRef: GoogleDriveTransportGenerationRef;
  readonly syncGenerationId: string;
}

export interface GoogleDriveInventoryPage {
  readonly objects: readonly RemoteObject[];
  readonly nextPageToken?: ProviderPageToken;
}

export interface GoogleDriveChangePage {
  readonly changes: readonly RemoteObjectChange[];
  readonly nextPageToken?: ProviderPageToken;
  readonly newCursor?: ProviderCursor;
}

/**
 * Native-only Google Drive capability.
 *
 * Implementations own OAuth refresh, bearer headers, HTTP, `appDataFolder`,
 * resumable session URIs, root-confined local refs, Range I/O and response
 * validation. None of those secrets or paths may be projected into renderer
 * state. Objects are trusted-cloud plaintext but remain immutable and are
 * addressed by deterministic logical identity plus SHA-256.
 */
export interface GoogleDriveObjectTransportPort {
  openGeneration(input: {
    credentialSecretRef: string;
    accountSubject: string;
    bindingId: string;
    syncGenerationId: string;
    authorityGeneration: number;
  }): Promise<GoogleDriveTransportSyncGeneration>;

  captureStartCursor(generation: GoogleDriveTransportSyncGeneration): Promise<ProviderCursor>;

  listInventory(input: {
    generation: GoogleDriveTransportSyncGeneration;
    pageToken?: ProviderPageToken;
  }): Promise<GoogleDriveInventoryPage>;

  listChanges(input: {
    generation: GoogleDriveTransportSyncGeneration;
    cursor: ProviderCursor;
    pageToken?: ProviderPageToken;
  }): Promise<GoogleDriveChangePage>;

  statImmutable(input: {
    generation: GoogleDriveTransportSyncGeneration;
    objectKind: SyncObjectKind;
    logicalKeyId: string;
  }): Promise<RemoteObject | null>;

  uploadImmutable(input: {
    generation: GoogleDriveTransportSyncGeneration;
    sourceRef: LocalObjectRef;
    objectKind: SyncObjectKind;
    logicalKeyId: string;
    storedSha256: Sha256;
    sizeBytes: number;
    transferId: string;
    signal: AbortSignal;
  }): Promise<{ readonly status: 'created' | 'already-present'; readonly object: RemoteObject }>;

  downloadVerifiedImmutable(input: {
    generation: GoogleDriveTransportSyncGeneration;
    objectId: ProviderObjectId;
    destinationRef: LocalObjectRef;
    expectedStoredSha256: Sha256;
    transferId: string;
    signal: AbortSignal;
  }): Promise<{
    readonly destinationRef: LocalObjectRef;
    readonly storedSha256: Sha256;
    readonly sizeBytes: number;
  }>;
}
