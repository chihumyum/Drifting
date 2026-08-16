import {
  compareUtf8Bytewise,
  createProviderCursor,
  createProviderPageToken,
  createProviderGenerationRef,
  SYNC_OBJECT_KINDS,
  type ChangeInput,
  type ChangePage,
  type DownloadResult,
  type InventoryInput,
  type InventoryPage,
  type LocalObjectRef,
  type ObjectIdentity,
  type ObjectLogProvider,
  type ProviderBinding,
  type ProviderCursor,
  type ProviderObjectId,
  type ProviderGeneration,
  type RemoteObject,
  type RemoteObjectChange,
  type Sha256,
  type SyncObjectKind,
  type UploadResult,
} from '../../protocol';
import { ObjectLogProviderError, throwIfProviderAborted } from '../provider-error';
import type {
  LocalFolderCatalogSnapshot,
  LocalFolderDurableChange,
  LocalFolderObjectTransportPort,
  LocalFolderTransportSyncGeneration,
} from './transport';

interface OpenGenerationRecord {
  readonly bindingId: string;
  readonly syncGenerationId: string;
  readonly authorityGeneration: number;
  readonly transportSyncGeneration: LocalFolderTransportSyncGeneration;
}

export interface LocalFolderObjectLogProviderOptions {
  readonly pageSize?: number;
}

function requireNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new TypeError(`${label} must not be empty`);
}

function assertSafeUnsignedInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertRootSecretRef(value: string | null): asserts value is string {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,254}$/u.test(value)
  ) {
    throw new ObjectLogProviderError(
      'INVALID_GENERATION',
      'Local-folder binding requires an opaque native root secret reference, never a path',
    );
  }
}

function parseIntegerToken(
  value: string,
  pattern: RegExp,
  code: 'INVALID_CURSOR' | 'INVALID_PAGE_TOKEN',
): number[] {
  const match = pattern.exec(value);
  if (!match) throw new ObjectLogProviderError(code, `Malformed local-folder token: ${value}`);
  const numbers = match.slice(1).map((part) => Number(part));
  if (numbers.some((number) => !Number.isSafeInteger(number) || number < 0)) {
    throw new ObjectLogProviderError(code, `Local-folder token is outside the safe range: ${value}`);
  }
  return numbers;
}

function cloneObject(object: RemoteObject): RemoteObject {
  return { ...object };
}

function cloneChange(change: RemoteObjectChange): RemoteObjectChange {
  return change.kind === 'present'
    ? { kind: 'present', object: cloneObject(change.object) }
    : { ...change };
}

function validateCatalog(snapshot: LocalFolderCatalogSnapshot): void {
  assertSafeUnsignedInteger(snapshot.latestRevision, 'latestRevision');
  let previousRevision = 0;
  const immutableIdentity = new Map<
    string,
    Pick<RemoteObject, 'objectKind' | 'storedSha256' | 'sizeBytes'>
  >();
  const currentByLogicalKey = new Map<string, RemoteObject>();
  const seenObjectIds = new Set<ProviderObjectId>();
  for (const entry of snapshot.changes) {
    if (!Number.isSafeInteger(entry.revision) || entry.revision !== previousRevision + 1) {
      throw new ObjectLogProviderError(
        'REMOTE_STORE_CORRUPT',
        `Local-folder catalog has a missing or duplicate revision after ${previousRevision}`,
      );
    }
    previousRevision = entry.revision;
    if (entry.change.kind === 'present') {
      const object = entry.change.object;
      if (
        !object.objectId.trim() ||
        !object.logicalKeyId.trim() ||
        !SYNC_OBJECT_KINDS.includes(object.objectKind) ||
        !/^sha256:[0-9a-f]{64}$/u.test(object.storedSha256)
      ) {
        throw new ObjectLogProviderError(
          'REMOTE_STORE_CORRUPT',
          'Local-folder catalog contains invalid object metadata',
        );
      }
      assertSafeUnsignedInteger(object.sizeBytes, 'catalog sizeBytes');
      if (seenObjectIds.has(object.objectId) || currentByLogicalKey.has(object.logicalKeyId)) {
        throw new ObjectLogProviderError(
          'REMOTE_STORE_CORRUPT',
          'Local-folder catalog reuses an object ID or replaces a live logical key',
        );
      }
      const identity = immutableIdentity.get(object.logicalKeyId);
      if (
        identity &&
        (identity.objectKind !== object.objectKind ||
          identity.storedSha256 !== object.storedSha256 ||
          identity.sizeBytes !== object.sizeBytes)
      ) {
        throw new ObjectLogProviderError(
          'REMOTE_STORE_CORRUPT',
          `Local-folder logical key ${object.logicalKeyId} has conflicting immutable identities`,
        );
      }
      immutableIdentity.set(object.logicalKeyId, {
        objectKind: object.objectKind,
        storedSha256: object.storedSha256,
        sizeBytes: object.sizeBytes,
      });
      currentByLogicalKey.set(object.logicalKeyId, object);
      seenObjectIds.add(object.objectId);
      continue;
    }
    const removal = entry.change;
    const current = removal.logicalKeyId
      ? currentByLogicalKey.get(removal.logicalKeyId)
      : [...currentByLogicalKey.values()].find(
          (candidate) => candidate.objectId === removal.objectId,
        );
    if (!current || current.objectId !== removal.objectId) {
      throw new ObjectLogProviderError(
        'REMOTE_STORE_CORRUPT',
        `Local-folder removal references a non-current object ${removal.objectId}`,
      );
    }
    currentByLogicalKey.delete(current.logicalKeyId);
  }
  if (previousRevision !== snapshot.latestRevision) {
    throw new ObjectLogProviderError(
      'REMOTE_STORE_CORRUPT',
      'Local-folder catalog frontier does not match its committed event sequence',
    );
  }
}

function inventoryAt(
  changes: readonly LocalFolderDurableChange[],
  cutoff: number,
): RemoteObject[] {
  const currentByLogicalKey = new Map<string, RemoteObject>();
  const logicalKeyByObjectId = new Map<ProviderObjectId, string>();
  for (const entry of changes) {
    if (entry.revision > cutoff) break;
    if (entry.change.kind === 'present') {
      const object = entry.change.object;
      currentByLogicalKey.set(object.logicalKeyId, object);
      logicalKeyByObjectId.set(object.objectId, object.logicalKeyId);
      continue;
    }
    const logicalKey =
      entry.change.logicalKeyId ?? logicalKeyByObjectId.get(entry.change.objectId) ?? null;
    if (
      logicalKey &&
      currentByLogicalKey.get(logicalKey)?.objectId === entry.change.objectId
    ) {
      currentByLogicalKey.delete(logicalKey);
    }
  }
  return [...currentByLogicalKey.values()]
    .sort(
      (left, right) =>
        compareUtf8Bytewise(left.logicalKeyId, right.logicalKeyId) ||
        compareUtf8Bytewise(left.objectId, right.objectId),
    )
    .map(cloneObject);
}

function currentObjectForLogicalKey(
  changes: readonly LocalFolderDurableChange[],
  logicalKeyId: string,
): RemoteObject | null {
  let current: RemoteObject | null = null;
  for (const entry of changes) {
    if (entry.change.kind === 'present' && entry.change.object.logicalKeyId === logicalKeyId) {
      current = entry.change.object;
    } else if (
      entry.change.kind === 'removed' &&
      current &&
      entry.change.objectId === current.objectId
    ) {
      current = null;
    }
  }
  return current ? cloneObject(current) : null;
}

function currentObjectById(
  changes: readonly LocalFolderDurableChange[],
  objectId: ProviderObjectId,
): RemoteObject | null {
  let present: RemoteObject | null = null;
  let removed = false;
  for (const entry of changes) {
    if (entry.change.kind === 'present' && entry.change.object.objectId === objectId) {
      present = entry.change.object;
      removed = false;
    } else if (entry.change.kind === 'removed' && entry.change.objectId === objectId) {
      removed = true;
    }
  }
  return present && !removed ? cloneObject(present) : null;
}

export class LocalFolderObjectLogProvider implements ObjectLogProvider {
  readonly kind = 'local-folder' as const;

  private readonly pageSize: number;
  private readonly transport: LocalFolderObjectTransportPort;
  private readonly openGenerations = new Map<string, OpenGenerationRecord>();
  private readonly generationRefByBinding = new Map<string, string>();
  private nextGenerationRef = 1;

  constructor(
    transport: LocalFolderObjectTransportPort,
    options: LocalFolderObjectLogProviderOptions = {},
  ) {
    const pageSize = options.pageSize ?? 100;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new RangeError('Local-folder provider pageSize must be a positive safe integer');
    }
    this.transport = transport;
    this.pageSize = pageSize;
  }

  async openGeneration(binding: ProviderBinding): Promise<ProviderGeneration> {
    requireNonEmpty(binding.bindingId, 'bindingId');
    requireNonEmpty(binding.syncGenerationId, 'syncGenerationId');
    assertRootSecretRef(binding.secretRef);
    if (!Number.isSafeInteger(binding.authorityGeneration) || binding.authorityGeneration < 1) {
      throw new ObjectLogProviderError(
        'INVALID_GENERATION',
        'Provider binding authority generation must be positive',
      );
    }

    const previousGenerationRef = this.generationRefByBinding.get(binding.bindingId);
    if (previousGenerationRef) {
      const previous = this.openGenerations.get(previousGenerationRef);
      if (
        !previous ||
        previous.syncGenerationId !== binding.syncGenerationId ||
        previous.authorityGeneration !== binding.authorityGeneration
      ) {
        throw new ObjectLogProviderError(
          'INVALID_GENERATION',
          'A local-folder binding cannot be reopened for another SyncGeneration or authority generation',
        );
      }
      return {
        bindingId: previous.bindingId,
        syncGenerationId: previous.syncGenerationId,
        generationRef: createProviderGenerationRef(previousGenerationRef),
      };
    }

    const transportSyncGeneration = await this.transport.openGeneration({
      rootSecretRef: binding.secretRef,
      bindingId: binding.bindingId,
      syncGenerationId: binding.syncGenerationId,
      authorityGeneration: binding.authorityGeneration,
    });
    if (transportSyncGeneration.syncGenerationId !== binding.syncGenerationId) {
      throw new ObjectLogProviderError(
        'INVALID_GENERATION',
        'Local-folder transport opened a different SyncGeneration than requested',
      );
    }
    const generationRef = `local-folder-generation:${this.nextGenerationRef++}`;
    this.openGenerations.set(generationRef, {
      bindingId: binding.bindingId,
      syncGenerationId: binding.syncGenerationId,
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

  async captureStartCursor(generation: ProviderGeneration): Promise<ProviderCursor> {
    const snapshot = await this.readCatalog(generation);
    return createProviderCursor(`local-folder-cursor:${snapshot.latestRevision}`);
  }

  async listInventory(input: InventoryInput): Promise<InventoryPage> {
    const snapshot = await this.readCatalog(input.generation);
    let cutoff: number;
    let offset: number;
    if (input.pageToken) {
      [cutoff, offset] = parseIntegerToken(
        input.pageToken,
        /^local-folder-inventory:(\d+):(\d+)$/u,
        'INVALID_PAGE_TOKEN',
      );
      if (cutoff > snapshot.latestRevision) {
        throw new ObjectLogProviderError('INVALID_PAGE_TOKEN', 'Inventory token is from the future');
      }
    } else {
      cutoff = snapshot.latestRevision;
      offset = 0;
    }

    const visible = inventoryAt(snapshot.changes, cutoff);
    if (offset > visible.length) {
      throw new ObjectLogProviderError('INVALID_PAGE_TOKEN', 'Inventory offset is out of range');
    }
    const objects = visible.slice(offset, offset + this.pageSize);
    const nextOffset = offset + objects.length;
    return {
      objects,
      ...(nextOffset < visible.length
        ? {
            nextPageToken: createProviderPageToken(
              `local-folder-inventory:${cutoff}:${nextOffset}`,
            ),
          }
        : {}),
    };
  }

  async listChanges(input: ChangeInput): Promise<ChangePage> {
    const snapshot = await this.readCatalog(input.generation);
    const [cursorRevision] = parseIntegerToken(
      input.cursor,
      /^local-folder-cursor:(\d+)$/u,
      'INVALID_CURSOR',
    );
    if (cursorRevision > snapshot.latestRevision) {
      throw new ObjectLogProviderError('INVALID_CURSOR', 'Change cursor is from the future');
    }

    let cutoff: number;
    let offset: number;
    if (input.pageToken) {
      const [tokenCursor, tokenCutoff, tokenOffset] = parseIntegerToken(
        input.pageToken,
        /^local-folder-changes:(\d+):(\d+):(\d+)$/u,
        'INVALID_PAGE_TOKEN',
      );
      if (tokenCursor !== cursorRevision || tokenCutoff > snapshot.latestRevision) {
        throw new ObjectLogProviderError(
          'INVALID_PAGE_TOKEN',
          'Change page token does not belong to this cursor',
        );
      }
      cutoff = tokenCutoff;
      offset = tokenOffset;
    } else {
      cutoff = snapshot.latestRevision;
      offset = 0;
    }

    const visible = snapshot.changes.filter(
      (entry) => entry.revision > cursorRevision && entry.revision <= cutoff,
    );
    if (offset > visible.length) {
      throw new ObjectLogProviderError('INVALID_PAGE_TOKEN', 'Change offset is out of range');
    }
    const changes = visible.slice(offset, offset + this.pageSize).map((entry) =>
      cloneChange(entry.change),
    );
    const nextOffset = offset + changes.length;
    if (nextOffset < visible.length) {
      return {
        changes,
        nextPageToken: createProviderPageToken(
          `local-folder-changes:${cursorRevision}:${cutoff}:${nextOffset}`,
        ),
      };
    }
    return {
      changes,
      newCursor: createProviderCursor(`local-folder-cursor:${cutoff}`),
    };
  }

  async statImmutable(input: ObjectIdentity): Promise<RemoteObject | null> {
    requireNonEmpty(input.logicalKeyId, 'logicalKeyId');
    const snapshot = await this.readCatalog(input.generation);
    const object = currentObjectForLogicalKey(snapshot.changes, input.logicalKeyId);
    if (!object) return null;
    if (object.objectKind !== input.objectKind) {
      throw new ObjectLogProviderError(
        'IMMUTABLE_OBJECT_CONFLICT',
        `Logical key ${input.logicalKeyId} already belongs to ${object.objectKind}`,
      );
    }
    return object;
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
  }): Promise<UploadResult> {
    const open = this.requireSyncGeneration(input.generation);
    throwIfProviderAborted(input.signal);
    requireNonEmpty(input.logicalKeyId, 'logicalKeyId');
    requireNonEmpty(input.transferId, 'transferId');
    assertSafeUnsignedInteger(input.sizeBytes, 'sizeBytes');
    const result = await this.transport.commitPresent({
      generation: open.transportSyncGeneration,
      sourceRef: input.sourceRef,
      objectKind: input.objectKind,
      logicalKeyId: input.logicalKeyId,
      storedSha256: input.storedSha256,
      sizeBytes: input.sizeBytes,
      transferId: input.transferId,
      signal: input.signal,
    });
    throwIfProviderAborted(input.signal);
    if (
      result.object.objectKind !== input.objectKind ||
      result.object.logicalKeyId !== input.logicalKeyId ||
      result.object.storedSha256 !== input.storedSha256 ||
      result.object.sizeBytes !== input.sizeBytes
    ) {
      throw new ObjectLogProviderError(
        'REMOTE_STORE_CORRUPT',
        'Local-folder transport committed metadata inconsistent with the upload request',
      );
    }
    return { status: result.status, object: cloneObject(result.object) };
  }

  async downloadImmutable(input: {
    generation: ProviderGeneration;
    objectId: ProviderObjectId;
    destinationRef: LocalObjectRef;
    expectedStoredSha256: Sha256;
    transferId: string;
    signal: AbortSignal;
  }): Promise<DownloadResult> {
    const open = this.requireSyncGeneration(input.generation);
    throwIfProviderAborted(input.signal);
    requireNonEmpty(input.transferId, 'transferId');
    const snapshot = await this.readCatalog(input.generation);
    const object = currentObjectById(snapshot.changes, input.objectId);
    if (!object) {
      throw new ObjectLogProviderError(
        'REMOTE_OBJECT_MISSING',
        `Remote object ${input.objectId} is unavailable`,
      );
    }
    if (object.storedSha256 !== input.expectedStoredSha256) {
      throw new ObjectLogProviderError(
        'HASH_MISMATCH',
        'Requested hash does not match immutable local-folder metadata',
      );
    }
    const result = await this.transport.materializeVerified({
      generation: open.transportSyncGeneration,
      objectId: input.objectId,
      destinationRef: input.destinationRef,
      expectedStoredSha256: input.expectedStoredSha256,
      transferId: input.transferId,
      signal: input.signal,
    });
    throwIfProviderAborted(input.signal);
    if (
      result.destinationRef !== input.destinationRef ||
      result.storedSha256 !== input.expectedStoredSha256 ||
      result.sizeBytes !== object.sizeBytes
    ) {
      throw new ObjectLogProviderError(
        'REMOTE_STORE_CORRUPT',
        'Local-folder transport returned metadata inconsistent with the committed object',
      );
    }
    return result;
  }

  private requireSyncGeneration(generation: ProviderGeneration): OpenGenerationRecord {
    const open = this.openGenerations.get(generation.generationRef);
    if (!open || open.bindingId !== generation.bindingId || open.syncGenerationId !== generation.syncGenerationId) {
      throw new ObjectLogProviderError('INVALID_GENERATION', 'Local-folder generationRef is invalid');
    }
    return open;
  }

  private async readCatalog(generation: ProviderGeneration): Promise<LocalFolderCatalogSnapshot> {
    const open = this.requireSyncGeneration(generation);
    const snapshot = await this.transport.readCatalog(open.transportSyncGeneration);
    validateCatalog(snapshot);
    return snapshot;
  }
}
