import {
  DOWNLOAD_RESULT_SCHEMA,
  REMOTE_OBJECT_CHANGE_SCHEMA,
  REMOTE_OBJECT_SCHEMA,
  UPLOAD_RESULT_SCHEMA,
  assertSchema,
  createLocalObjectRef,
  createProviderCursor,
  createProviderObjectId,
  createProviderPageToken,
  createProviderGenerationRef,
  type ChangeInput,
  type ChangePage,
  type DownloadResult,
  type InventoryInput,
  type InventoryPage,
  type LocalObjectRef,
  type ObjectIdentity,
  type ObjectLogProvider,
  type ProviderBinding,
  type ProviderObjectId,
  type ProviderGeneration,
  type RemoteObject,
  type Sha256,
  type SyncObjectKind,
  type TransferProgress,
  type UploadResult,
} from '../../protocol';
import { ObjectLogProviderError, throwIfProviderAborted } from '../provider-error';
import type {
  GoogleDriveObjectTransportPort,
  GoogleDriveTransportSyncGeneration,
} from './transport';

interface OpenGenerationRecord {
  readonly bindingId: string;
  readonly syncGenerationId: string;
  readonly accountSubject: string;
  readonly authorityGeneration: number;
  readonly transportSyncGeneration: GoogleDriveTransportSyncGeneration;
}

function nonEmpty(value: string | null, label: string): asserts value is string {
  if (!value?.trim()) throw new ObjectLogProviderError('INVALID_GENERATION', `${label} is required`);
}

function safeSize(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', `${label} is malformed`);
  }
}

function cloneObject(value: RemoteObject): RemoteObject {
  assertSchema(REMOTE_OBJECT_SCHEMA, value, 'Google Drive remote object');
  return { ...value, objectId: createProviderObjectId(value.objectId) };
}

function assertUploadedObject(
  object: RemoteObject,
  expected: {
    objectKind: SyncObjectKind;
    logicalKeyId: string;
    storedSha256: Sha256;
    sizeBytes: number;
  },
): void {
  if (
    object.objectKind !== expected.objectKind ||
    object.logicalKeyId !== expected.logicalKeyId ||
    object.storedSha256 !== expected.storedSha256 ||
    object.sizeBytes !== expected.sizeBytes
  ) {
    throw new ObjectLogProviderError(
      'REMOTE_STORE_CORRUPT',
      'Google Drive returned metadata inconsistent with the immutable upload',
    );
  }
}

/** Thin product adapter; all Google credentials, HTTP and file streaming stay native. */
export class GoogleDriveObjectLogProvider implements ObjectLogProvider {
  readonly kind = 'google-drive' as const;

  private readonly transport: GoogleDriveObjectTransportPort;
  private readonly openGenerations = new Map<string, OpenGenerationRecord>();
  private readonly generationRefByBinding = new Map<string, string>();
  private nextGenerationRef = 1;

  constructor(transport: GoogleDriveObjectTransportPort) {
    this.transport = transport;
  }

  async openGeneration(binding: ProviderBinding): Promise<ProviderGeneration> {
    nonEmpty(binding.bindingId, 'bindingId');
    nonEmpty(binding.syncGenerationId, 'syncGenerationId');
    nonEmpty(binding.accountRef, 'Google account subject');
    nonEmpty(binding.secretRef, 'Google credential secret reference');
    if (!Number.isSafeInteger(binding.authorityGeneration) || binding.authorityGeneration < 1) {
      throw new ObjectLogProviderError(
        'INVALID_GENERATION',
        'Provider binding authority generation must be positive',
      );
    }

    const existingGenerationRef = this.generationRefByBinding.get(binding.bindingId);
    if (existingGenerationRef) {
      const existing = this.openGenerations.get(existingGenerationRef);
      if (
        !existing ||
        existing.syncGenerationId !== binding.syncGenerationId ||
        existing.accountSubject !== binding.accountRef ||
        existing.authorityGeneration !== binding.authorityGeneration
      ) {
        throw new ObjectLogProviderError(
          'INVALID_GENERATION',
          'A Drive binding cannot be reopened for another account, SyncGeneration or authority generation',
        );
      }
      return {
        bindingId: existing.bindingId,
        syncGenerationId: existing.syncGenerationId,
        generationRef: createProviderGenerationRef(existingGenerationRef),
      };
    }

    const transportSyncGeneration = await this.transport.openGeneration({
      credentialSecretRef: binding.secretRef,
      accountSubject: binding.accountRef,
      bindingId: binding.bindingId,
      syncGenerationId: binding.syncGenerationId,
      authorityGeneration: binding.authorityGeneration,
    });
    if (transportSyncGeneration.syncGenerationId !== binding.syncGenerationId) {
      throw new ObjectLogProviderError(
        'INVALID_GENERATION',
        'Google Drive transport opened a different SyncGeneration than requested',
      );
    }
    const generationRef = `google-drive-generation:${this.nextGenerationRef++}`;
    this.openGenerations.set(generationRef, {
      bindingId: binding.bindingId,
      syncGenerationId: binding.syncGenerationId,
      accountSubject: binding.accountRef,
      authorityGeneration: binding.authorityGeneration,
      transportSyncGeneration,
    });
    this.generationRefByBinding.set(binding.bindingId, generationRef);
    return {
      bindingId: binding.bindingId,
      syncGenerationId: binding.syncGenerationId,
      generationRef: createProviderGenerationRef(generationRef),
    };
  }

  async captureStartCursor(generation: ProviderGeneration) {
    const cursor = await this.transport.captureStartCursor(
      this.requireSyncGeneration(generation).transportSyncGeneration,
    );
    return createProviderCursor(cursor);
  }

  async listInventory(input: InventoryInput): Promise<InventoryPage> {
    const page = await this.transport.listInventory({
      generation: this.requireSyncGeneration(input.generation).transportSyncGeneration,
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    });
    return {
      objects: Object.freeze(page.objects.map(cloneObject)),
      ...(page.nextPageToken
        ? { nextPageToken: createProviderPageToken(page.nextPageToken) }
        : {}),
    };
  }

  async listChanges(input: ChangeInput): Promise<ChangePage> {
    const page = await this.transport.listChanges({
      generation: this.requireSyncGeneration(input.generation).transportSyncGeneration,
      cursor: input.cursor,
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    });
    return {
      changes: Object.freeze(
        page.changes.map((change) => {
          assertSchema(REMOTE_OBJECT_CHANGE_SCHEMA, change, 'Google Drive remote change');
          return change.kind === 'present'
            ? { kind: 'present' as const, object: cloneObject(change.object) }
            : {
                ...change,
                objectId: createProviderObjectId(change.objectId),
              };
        }),
      ),
      ...(page.nextPageToken
        ? { nextPageToken: createProviderPageToken(page.nextPageToken) }
        : {}),
      ...(page.newCursor ? { newCursor: createProviderCursor(page.newCursor) } : {}),
    };
  }

  async statImmutable(input: ObjectIdentity): Promise<RemoteObject | null> {
    const result = await this.transport.statImmutable({
      generation: this.requireSyncGeneration(input.generation).transportSyncGeneration,
      objectKind: input.objectKind,
      logicalKeyId: input.logicalKeyId,
    });
    return result ? cloneObject(result) : null;
  }

  async uploadImmutable(input: {
    generation: ProviderGeneration;
    sourceRef: LocalObjectRef;
    objectKind: SyncObjectKind;
    logicalKeyId: string;
    storedSha256: Sha256;
    sizeBytes: number;
    transferId: string;
    signal: AbortSignal;
    onProgress?: (progress: TransferProgress) => void;
  }): Promise<UploadResult> {
    throwIfProviderAborted(input.signal);
    safeSize(input.sizeBytes, 'upload size');
    nonEmpty(input.logicalKeyId, 'logicalKeyId');
    nonEmpty(input.transferId, 'transferId');
    const result = await this.transport.uploadImmutable({
      ...input,
      generation: this.requireSyncGeneration(input.generation).transportSyncGeneration,
    });
    throwIfProviderAborted(input.signal);
    assertSchema(UPLOAD_RESULT_SCHEMA, result, 'Google Drive upload result');
    assertUploadedObject(result.object, input);
    return { status: result.status, object: cloneObject(result.object) };
  }

  async downloadImmutable(input: {
    generation: ProviderGeneration;
    objectId: ProviderObjectId;
    destinationRef: LocalObjectRef;
    expectedStoredSha256: Sha256;
    transferId: string;
    signal: AbortSignal;
    onProgress?: (progress: TransferProgress) => void;
  }): Promise<DownloadResult> {
    throwIfProviderAborted(input.signal);
    nonEmpty(input.transferId, 'transferId');
    const result = await this.transport.downloadVerifiedImmutable({
      ...input,
      generation: this.requireSyncGeneration(input.generation).transportSyncGeneration,
    });
    throwIfProviderAborted(input.signal);
    assertSchema(DOWNLOAD_RESULT_SCHEMA, result, 'Google Drive download result');
    safeSize(result.sizeBytes, 'download size');
    if (
      result.destinationRef !== input.destinationRef ||
      result.storedSha256 !== input.expectedStoredSha256
    ) {
      throw new ObjectLogProviderError(
        'REMOTE_STORE_CORRUPT',
        'Google Drive returned metadata inconsistent with the verified download',
      );
    }
    return {
      ...result,
      destinationRef: createLocalObjectRef(result.destinationRef),
    };
  }

  private requireSyncGeneration(generation: ProviderGeneration): OpenGenerationRecord {
    const open = this.openGenerations.get(generation.generationRef);
    if (!open || open.bindingId !== generation.bindingId || open.syncGenerationId !== generation.syncGenerationId) {
      throw new ObjectLogProviderError('INVALID_GENERATION', 'Google Drive generationRef is invalid');
    }
    return open;
  }
}
