import {
  compareUtf8Bytewise,
  createProviderCursor,
  createProviderObjectId,
  createProviderPageToken,
  createProviderGenerationRef,
  sha256Bytes,
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
} from '../protocol';
import type { ProviderLocalObjectStore } from './local-object-store';
import { ObjectLogProviderError, throwIfProviderAborted } from './provider-error';

interface MemoryObjectRecord {
  object: RemoteObject;
  bytes: Uint8Array;
  createdRevision: number;
  removedRevision: number | null;
}

interface ImmutableIdentityRecord {
  objectKind: SyncObjectKind;
  storedSha256: Sha256;
  sizeBytes: number;
}

interface MemoryChangeRecord {
  revision: number;
  change: RemoteObjectChange;
}

interface MemorySyncGenerationState {
  syncGenerationId: string;
  revision: number;
  nextObjectId: number;
  records: MemoryObjectRecord[];
  currentByLogicalKey: Map<string, MemoryObjectRecord>;
  byObjectId: Map<ProviderObjectId, MemoryObjectRecord>;
  immutableIdentities: Map<string, ImmutableIdentityRecord>;
  changes: MemoryChangeRecord[];
}

interface OpenGenerationRecord {
  bindingId: string;
  syncGenerationId: string;
  authorityGeneration: number;
  state: MemorySyncGenerationState;
}

export interface MemoryObjectLogProviderOptions {
  pageSize?: number;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function cloneRemoteObject(object: RemoteObject): RemoteObject {
  return { ...object };
}

function cloneChange(change: RemoteObjectChange): RemoteObjectChange {
  return change.kind === 'present'
    ? { kind: 'present', object: cloneRemoteObject(change.object) }
    : { ...change };
}

function assertSafeUnsignedInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new TypeError(`${label} must not be empty`);
}

function parseIntegerToken(value: string, pattern: RegExp, code: 'INVALID_CURSOR' | 'INVALID_PAGE_TOKEN') {
  const match = pattern.exec(value);
  if (!match) throw new ObjectLogProviderError(code, `Malformed provider token: ${value}`);
  const values = match.slice(1).map((part) => Number(part));
  if (values.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw new ObjectLogProviderError(code, `Provider token is outside the safe integer range: ${value}`);
  }
  return values;
}

export class MemoryObjectLogProvider implements ObjectLogProvider {
  readonly kind = 'memory' as const;

  private readonly pageSize: number;
  private readonly localObjects: ProviderLocalObjectStore;
  private readonly generationStates = new Map<string, MemorySyncGenerationState>();
  private readonly openGenerations = new Map<string, OpenGenerationRecord>();
  private nextGenerationRef = 1;

  constructor(
    localObjects: ProviderLocalObjectStore,
    options: MemoryObjectLogProviderOptions = {},
  ) {
    const pageSize = options.pageSize ?? 100;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new RangeError('Memory provider pageSize must be a positive safe integer');
    }
    this.pageSize = pageSize;
    this.localObjects = localObjects;
  }

  async openGeneration(binding: ProviderBinding): Promise<ProviderGeneration> {
    requireNonEmpty(binding.bindingId, 'bindingId');
    requireNonEmpty(binding.syncGenerationId, 'syncGenerationId');
    if (!Number.isSafeInteger(binding.authorityGeneration) || binding.authorityGeneration < 1) {
      throw new ObjectLogProviderError(
        'INVALID_GENERATION',
        'Provider binding authority generation must be positive',
      );
    }

    const existing = [...this.openGenerations.values()].find(
      (record) => record.bindingId === binding.bindingId,
    );
    if (existing) {
      if (
        existing.syncGenerationId !== binding.syncGenerationId ||
        existing.authorityGeneration !== binding.authorityGeneration
      ) {
        throw new ObjectLogProviderError(
          'INVALID_GENERATION',
          'A provider binding cannot be reopened for another SyncGeneration or authority generation',
        );
      }
      const generationRef = [...this.openGenerations.entries()].find(([, record]) => record === existing)?.[0];
      if (!generationRef) throw new Error('Memory provider open-generation index is inconsistent');
      return {
        bindingId: existing.bindingId,
        syncGenerationId: existing.syncGenerationId,
        generationRef: createProviderGenerationRef(generationRef),
      };
    }

    let state = this.generationStates.get(binding.syncGenerationId);
    if (!state) {
      state = {
        syncGenerationId: binding.syncGenerationId,
        revision: 0,
        nextObjectId: 1,
        records: [],
        currentByLogicalKey: new Map(),
        byObjectId: new Map(),
        immutableIdentities: new Map(),
        changes: [],
      };
      this.generationStates.set(binding.syncGenerationId, state);
    }
    const generationRef = `memory-generation:${this.nextGenerationRef++}`;
    this.openGenerations.set(generationRef, {
      bindingId: binding.bindingId,
      syncGenerationId: binding.syncGenerationId,
      authorityGeneration: binding.authorityGeneration,
      state,
    });
    return {
      bindingId: binding.bindingId,
      syncGenerationId: binding.syncGenerationId,
      generationRef: createProviderGenerationRef(generationRef),
    };
  }

  async captureStartCursor(generation: ProviderGeneration): Promise<ProviderCursor> {
    const state = this.requireSyncGeneration(generation);
    return createProviderCursor(`memory-cursor:${state.revision}`);
  }

  async listInventory(input: InventoryInput): Promise<InventoryPage> {
    const state = this.requireSyncGeneration(input.generation);
    let cutoff: number;
    let offset: number;
    if (input.pageToken) {
      [cutoff, offset] = parseIntegerToken(
        input.pageToken,
        /^memory-inventory:(\d+):(\d+)$/u,
        'INVALID_PAGE_TOKEN',
      );
      if (cutoff > state.revision) {
        throw new ObjectLogProviderError('INVALID_PAGE_TOKEN', 'Inventory token is from the future');
      }
    } else {
      cutoff = state.revision;
      offset = 0;
    }

    const visible = state.records
      .filter(
        (record) =>
          record.createdRevision <= cutoff &&
          (record.removedRevision === null || record.removedRevision > cutoff),
      )
      .sort(
        (left, right) =>
          compareUtf8Bytewise(left.object.logicalKeyId, right.object.logicalKeyId) ||
          compareUtf8Bytewise(left.object.objectId, right.object.objectId),
      );
    if (offset > visible.length) {
      throw new ObjectLogProviderError('INVALID_PAGE_TOKEN', 'Inventory offset is out of range');
    }
    const page = visible.slice(offset, offset + this.pageSize);
    const nextOffset = offset + page.length;
    return {
      objects: page.map((record) => cloneRemoteObject(record.object)),
      ...(nextOffset < visible.length
        ? { nextPageToken: createProviderPageToken(`memory-inventory:${cutoff}:${nextOffset}`) }
        : {}),
    };
  }

  async listChanges(input: ChangeInput): Promise<ChangePage> {
    const state = this.requireSyncGeneration(input.generation);
    const [cursorRevision] = parseIntegerToken(
      input.cursor,
      /^memory-cursor:(\d+)$/u,
      'INVALID_CURSOR',
    );
    if (cursorRevision > state.revision) {
      throw new ObjectLogProviderError('INVALID_CURSOR', 'Change cursor is from the future');
    }

    let cutoff: number;
    let offset: number;
    if (input.pageToken) {
      const values = parseIntegerToken(
        input.pageToken,
        /^memory-changes:(\d+):(\d+):(\d+)$/u,
        'INVALID_PAGE_TOKEN',
      );
      const [tokenCursor, tokenCutoff, tokenOffset] = values;
      if (tokenCursor !== cursorRevision || tokenCutoff > state.revision) {
        throw new ObjectLogProviderError(
          'INVALID_PAGE_TOKEN',
          'Change page token does not belong to this cursor',
        );
      }
      cutoff = tokenCutoff;
      offset = tokenOffset;
    } else {
      cutoff = state.revision;
      offset = 0;
    }

    const visible = state.changes.filter(
      (record) => record.revision > cursorRevision && record.revision <= cutoff,
    );
    if (offset > visible.length) {
      throw new ObjectLogProviderError('INVALID_PAGE_TOKEN', 'Change offset is out of range');
    }
    const page = visible.slice(offset, offset + this.pageSize);
    const nextOffset = offset + page.length;
    if (nextOffset < visible.length) {
      return {
        changes: page.map((record) => cloneChange(record.change)),
        nextPageToken: createProviderPageToken(
          `memory-changes:${cursorRevision}:${cutoff}:${nextOffset}`,
        ),
      };
    }
    return {
      changes: page.map((record) => cloneChange(record.change)),
      newCursor: createProviderCursor(`memory-cursor:${cutoff}`),
    };
  }

  async statImmutable(input: ObjectIdentity): Promise<RemoteObject | null> {
    const state = this.requireSyncGeneration(input.generation);
    const record = state.currentByLogicalKey.get(input.logicalKeyId);
    if (!record) return null;
    if (record.object.objectKind !== input.objectKind) {
      throw new ObjectLogProviderError(
        'IMMUTABLE_OBJECT_CONFLICT',
        `Logical key ${input.logicalKeyId} already belongs to ${record.object.objectKind}`,
      );
    }
    return cloneRemoteObject(record.object);
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
    const state = this.requireSyncGeneration(input.generation);
    throwIfProviderAborted(input.signal);
    requireNonEmpty(input.logicalKeyId, 'logicalKeyId');
    requireNonEmpty(input.transferId, 'transferId');
    assertSafeUnsignedInteger(input.sizeBytes, 'sizeBytes');
    const bytes = await this.localObjects.read(input.sourceRef, input.signal);
    throwIfProviderAborted(input.signal);
    if (bytes.byteLength !== input.sizeBytes) {
      throw new ObjectLogProviderError(
        'SIZE_MISMATCH',
        `Local object has ${bytes.byteLength} bytes; expected ${input.sizeBytes}`,
      );
    }
    const actualHash = await sha256Bytes(bytes);
    if (actualHash !== input.storedSha256) {
      throw new ObjectLogProviderError(
        'HASH_MISMATCH',
        `Local object hash ${actualHash} does not match ${input.storedSha256}`,
      );
    }

    const identity = state.immutableIdentities.get(input.logicalKeyId);
    if (
      identity &&
      (identity.objectKind !== input.objectKind ||
        identity.storedSha256 !== input.storedSha256 ||
        identity.sizeBytes !== input.sizeBytes)
    ) {
      throw new ObjectLogProviderError(
        'IMMUTABLE_OBJECT_CONFLICT',
        `Logical key ${input.logicalKeyId} cannot be overwritten with different bytes or metadata`,
      );
    }

    const current = state.currentByLogicalKey.get(input.logicalKeyId);
    if (current) return { status: 'already-present', object: cloneRemoteObject(current.object) };

    const object: RemoteObject = {
      objectId: createProviderObjectId(`memory-object:${state.nextObjectId++}`),
      objectKind: input.objectKind,
      logicalKeyId: input.logicalKeyId,
      storedSha256: input.storedSha256,
      sizeBytes: input.sizeBytes,
    };
    const revision = ++state.revision;
    const record: MemoryObjectRecord = {
      object,
      bytes: cloneBytes(bytes),
      createdRevision: revision,
      removedRevision: null,
    };
    state.records.push(record);
    state.byObjectId.set(object.objectId, record);
    state.currentByLogicalKey.set(object.logicalKeyId, record);
    state.immutableIdentities.set(object.logicalKeyId, {
      objectKind: object.objectKind,
      storedSha256: object.storedSha256,
      sizeBytes: object.sizeBytes,
    });
    state.changes.push({
      revision,
      change: { kind: 'present', object: cloneRemoteObject(object) },
    });
    return { status: 'created', object: cloneRemoteObject(object) };
  }

  async downloadImmutable(input: {
    generation: ProviderGeneration;
    objectId: ProviderObjectId;
    destinationRef: LocalObjectRef;
    expectedStoredSha256: Sha256;
    transferId: string;
    signal: AbortSignal;
  }): Promise<DownloadResult> {
    const state = this.requireSyncGeneration(input.generation);
    throwIfProviderAborted(input.signal);
    requireNonEmpty(input.transferId, 'transferId');
    const record = state.byObjectId.get(input.objectId);
    if (!record || record.removedRevision !== null) {
      throw new ObjectLogProviderError(
        'REMOTE_OBJECT_MISSING',
        `Remote object ${input.objectId} is unavailable`,
      );
    }
    if (record.object.storedSha256 !== input.expectedStoredSha256) {
      throw new ObjectLogProviderError(
        'HASH_MISMATCH',
        'Requested hash does not match immutable remote metadata',
      );
    }
    const bytes = cloneBytes(record.bytes);
    const actualHash = await sha256Bytes(bytes);
    if (actualHash !== input.expectedStoredSha256 || bytes.byteLength !== record.object.sizeBytes) {
      throw new ObjectLogProviderError(
        'HASH_MISMATCH',
        'Stored object bytes no longer match immutable remote metadata',
      );
    }
    throwIfProviderAborted(input.signal);
    await this.localObjects.write(input.destinationRef, bytes, input.signal);
    return {
      destinationRef: input.destinationRef,
      storedSha256: input.expectedStoredSha256,
      sizeBytes: bytes.byteLength,
    };
  }

  /** Test-only provider degradation: it is a transport change, never a domain delete. */
  removeRemoteObject(generation: ProviderGeneration, logicalKeyId: string): RemoteObjectChange | null {
    const state = this.requireSyncGeneration(generation);
    const record = state.currentByLogicalKey.get(logicalKeyId);
    if (!record) return null;
    const revision = ++state.revision;
    record.removedRevision = revision;
    state.currentByLogicalKey.delete(logicalKeyId);
    const change: RemoteObjectChange = {
      kind: 'removed',
      objectId: record.object.objectId,
      logicalKeyId,
    };
    state.changes.push({ revision, change });
    return cloneChange(change);
  }

  /** Test seam for proving that downloaded hashes are verified before destination writes. */
  corruptRemoteBytes(generation: ProviderGeneration, objectId: ProviderObjectId): void {
    const state = this.requireSyncGeneration(generation);
    const record = state.byObjectId.get(objectId);
    if (!record) throw new ObjectLogProviderError('REMOTE_OBJECT_MISSING', 'Object not found');
    if (record.bytes.byteLength === 0) record.bytes = Uint8Array.of(1);
    else record.bytes[0] = (record.bytes[0] ?? 0) ^ 0xff;
  }

  private requireSyncGeneration(generation: ProviderGeneration): MemorySyncGenerationState {
    const open = this.openGenerations.get(generation.generationRef);
    if (
      !open ||
      open.bindingId !== generation.bindingId ||
      open.syncGenerationId !== generation.syncGenerationId ||
      open.state.syncGenerationId !== generation.syncGenerationId
    ) {
      throw new ObjectLogProviderError('INVALID_GENERATION', 'Provider generationRef is invalid');
    }
    return open.state;
  }
}
