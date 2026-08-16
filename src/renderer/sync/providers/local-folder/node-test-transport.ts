/**
 * Node-only filesystem implementation used by provider conformance and crash
 * tests. Product code must bind LocalFolderObjectTransportPort to the native
 * root-confined object store instead of importing this module.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  createProviderObjectId,
  sha256Bytes,
  SYNC_OBJECT_KINDS,
  type ProviderObjectId,
  type RemoteObject,
  type Sha256,
} from '../../protocol';
import type { ProviderLocalObjectStore } from '../local-object-store';
import { ObjectLogProviderError, throwIfProviderAborted } from '../provider-error';
import {
  createLocalFolderTransportGenerationRef,
  type LocalFolderCatalogSnapshot,
  type LocalFolderCommitPresentResult,
  type LocalFolderDurableChange,
  type LocalFolderMaterializeResult,
  type LocalFolderObjectTransportPort,
  type LocalFolderTransportSyncGeneration,
} from './transport';

export type LocalFolderDurabilityBoundary =
  | 'stage-durable'
  | 'commit-renamed'
  | 'commit-directory-durable';

export interface NodeLocalFolderTestTransportOptions {
  readonly acceptedRootSecretRef?: string;
  readonly onDurabilityBoundary?: (
    boundary: LocalFolderDurabilityBoundary,
  ) => void | Promise<void>;
}

interface OpenGenerationState {
  readonly transportSyncGeneration: LocalFolderTransportSyncGeneration;
  readonly generationPath: string;
  readonly eventsPath: string;
  readonly stagingPath: string;
}

interface PersistedPresentChange {
  readonly kind: 'present';
  readonly object: {
    readonly objectId: string;
    readonly objectKind: RemoteObject['objectKind'];
    readonly logicalKeyId: string;
    readonly storedSha256: string;
    readonly sizeBytes: number;
  };
}

interface PersistedRemovedChange {
  readonly kind: 'removed';
  readonly objectId: string;
  readonly logicalKeyId: string | null;
}

interface PersistedEvent {
  readonly format: 'drifting.local-folder.event';
  readonly version: 1;
  readonly revision: number;
  readonly change: PersistedPresentChange | PersistedRemovedChange;
}

interface LoadedEvent {
  readonly directoryName: string;
  readonly event: LocalFolderDurableChange;
}

const EVENT_FILE = 'event.json';
const OBJECT_FILE = 'object.bin';
const SYNC_GENERATION_FILE = 'generation.json';

function encodePathComponent(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function assertSafeChild(parent: string, child: string): string {
  const resolvedParent = path.resolve(parent);
  const resolved = path.resolve(parent, child);
  if (resolved === resolvedParent || !resolved.startsWith(`${resolvedParent}${path.sep}`)) {
    throw new ObjectLogProviderError('INVALID_GENERATION', 'Resolved local-folder path escaped its root');
  }
  return resolved;
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', `${label} is not a safe integer`);
  }
}

function assertSha256(value: unknown): asserts value is Sha256 {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Invalid stored SHA-256 metadata');
  }
}

function parsePersistedEvent(value: unknown): LocalFolderDurableChange {
  if (!value || typeof value !== 'object') {
    throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Event metadata is not an object');
  }
  const candidate = value as Partial<PersistedEvent>;
  if (
    candidate.format !== 'drifting.local-folder.event' ||
    candidate.version !== 1 ||
    !candidate.change
  ) {
    throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Unsupported local-folder event');
  }
  assertNonNegativeSafeInteger(candidate.revision, 'revision');
  if (candidate.revision < 1) {
    throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Event revision must be positive');
  }
  const change = candidate.change;
  if (change.kind === 'present') {
    const object = change.object;
    if (
      !object ||
      typeof object.objectId !== 'string' ||
      typeof object.objectKind !== 'string' ||
      !SYNC_OBJECT_KINDS.includes(object.objectKind) ||
      typeof object.logicalKeyId !== 'string'
    ) {
      throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Present event metadata is invalid');
    }
    assertSha256(object.storedSha256);
    assertNonNegativeSafeInteger(object.sizeBytes, 'sizeBytes');
    return {
      revision: candidate.revision,
      change: {
        kind: 'present',
        object: {
          objectId: createProviderObjectId(object.objectId),
          objectKind: object.objectKind,
          logicalKeyId: object.logicalKeyId,
          storedSha256: object.storedSha256,
          sizeBytes: object.sizeBytes,
        } as RemoteObject,
      },
    };
  }
  if (
    change.kind !== 'removed' ||
    typeof change.objectId !== 'string' ||
    !(typeof change.logicalKeyId === 'string' || change.logicalKeyId === null)
  ) {
    throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'Removal event metadata is invalid');
  }
  return {
    revision: candidate.revision,
    change: {
      kind: 'removed',
      objectId: createProviderObjectId(change.objectId),
      logicalKeyId: change.logicalKeyId,
    },
  };
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeNewDurable(filePath: string, bytes: Uint8Array | string): Promise<void> {
  const handle = await open(filePath, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function currentByLogicalKey(changes: readonly LocalFolderDurableChange[]): Map<string, RemoteObject> {
  const current = new Map<string, RemoteObject>();
  const logicalByObject = new Map<ProviderObjectId, string>();
  for (const entry of changes) {
    if (entry.change.kind === 'present') {
      current.set(entry.change.object.logicalKeyId, entry.change.object);
      logicalByObject.set(entry.change.object.objectId, entry.change.object.logicalKeyId);
      continue;
    }
    const logical = entry.change.logicalKeyId ?? logicalByObject.get(entry.change.objectId);
    if (logical && current.get(logical)?.objectId === entry.change.objectId) {
      current.delete(logical);
    }
  }
  return current;
}

export class NodeLocalFolderTestTransport implements LocalFolderObjectTransportPort {
  private readonly rootPath: string;
  private readonly localObjects: ProviderLocalObjectStore;
  private readonly acceptedRootSecretRef: string;
  private readonly onDurabilityBoundary?: NodeLocalFolderTestTransportOptions['onDurabilityBoundary'];
  private readonly openGenerations = new Map<string, OpenGenerationState>();
  private readonly locks = new Map<string, Promise<void>>();
  private nextGenerationRef = 1;

  constructor(
    rootPath: string,
    localObjects: ProviderLocalObjectStore,
    options: NodeLocalFolderTestTransportOptions = {},
  ) {
    if (!path.isAbsolute(rootPath)) {
      throw new TypeError('Node test transport root must be an absolute test-owned path');
    }
    this.rootPath = path.resolve(rootPath);
    this.localObjects = localObjects;
    this.acceptedRootSecretRef = options.acceptedRootSecretRef ?? 'local-folder-root:test';
    this.onDurabilityBoundary = options.onDurabilityBoundary;
  }

  async openGeneration(input: {
    rootSecretRef: string;
    bindingId: string;
    syncGenerationId: string;
    authorityGeneration: number;
  }): Promise<LocalFolderTransportSyncGeneration> {
    if (input.rootSecretRef !== this.acceptedRootSecretRef) {
      throw new ObjectLogProviderError('INVALID_GENERATION', 'Unknown native local-folder root reference');
    }
    await mkdir(this.rootPath, { recursive: true });
    const generationsPath = assertSafeChild(this.rootPath, 'generations');
    await mkdir(generationsPath, { recursive: true });
    const generationPath = assertSafeChild(generationsPath, encodePathComponent(input.syncGenerationId));
    const eventsPath = assertSafeChild(generationPath, 'events');
    const stagingPath = assertSafeChild(generationPath, 'staging');
    await mkdir(eventsPath, { recursive: true });
    await mkdir(stagingPath, { recursive: true });

    const generationFile = assertSafeChild(generationPath, SYNC_GENERATION_FILE);
    if (await exists(generationFile)) {
      let metadata: { format?: unknown; version?: unknown; syncGenerationId?: unknown };
      try {
        metadata = JSON.parse(await readFile(generationFile, 'utf8')) as typeof metadata;
      } catch {
        throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'SyncGeneration metadata is unreadable');
      }
      if (
        metadata.format !== 'drifting.local-folder.generation' ||
        metadata.version !== 1 ||
        metadata.syncGenerationId !== input.syncGenerationId
      ) {
        throw new ObjectLogProviderError('REMOTE_STORE_CORRUPT', 'SyncGeneration directory identity mismatch');
      }
    } else {
      const temporary = assertSafeChild(generationPath, `.sync-generation-${randomUUID()}.tmp`);
      await writeNewDurable(
        temporary,
        `${JSON.stringify({ format: 'drifting.local-folder.generation', version: 1, syncGenerationId: input.syncGenerationId })}\n`,
      );
      await rename(temporary, generationFile);
      await fsyncDirectory(generationPath);
      await fsyncDirectory(generationsPath);
    }

    for (const name of await readdir(stagingPath)) {
      await rm(assertSafeChild(stagingPath, name), { recursive: true, force: true });
    }
    await fsyncDirectory(stagingPath);

    const handle = `syncfolder:test.${this.nextGenerationRef++}`;
    const transportSyncGeneration: LocalFolderTransportSyncGeneration = {
      generationRef: createLocalFolderTransportGenerationRef(handle),
      syncGenerationId: input.syncGenerationId,
    };
    this.openGenerations.set(handle, { transportSyncGeneration, generationPath, eventsPath, stagingPath });
    return transportSyncGeneration;
  }

  async readCatalog(generation: LocalFolderTransportSyncGeneration): Promise<LocalFolderCatalogSnapshot> {
    const state = this.requireSyncGeneration(generation);
    const events = await this.loadEvents(state);
    return {
      latestRevision: events.length,
      changes: events.map((entry) => entry.event),
    };
  }

  async commitPresent(
    input: Parameters<LocalFolderObjectTransportPort['commitPresent']>[0],
  ): Promise<LocalFolderCommitPresentResult> {
    const state = this.requireSyncGeneration(input.generation);
    return this.withSyncGenerationLock(state, async () => {
      throwIfProviderAborted(input.signal);
      const bytes = await this.localObjects.read(input.sourceRef, input.signal);
      throwIfProviderAborted(input.signal);
      if (bytes.byteLength !== input.sizeBytes) {
        throw new ObjectLogProviderError(
          'SIZE_MISMATCH',
          `Local transfer object has ${bytes.byteLength} bytes; expected ${input.sizeBytes}`,
        );
      }
      const actualHash = await sha256Bytes(bytes);
      if (actualHash !== input.storedSha256) {
        throw new ObjectLogProviderError(
          'HASH_MISMATCH',
          `Local transfer object hash ${actualHash} does not match ${input.storedSha256}`,
        );
      }

      const loaded = await this.loadEvents(state);
      const changes = loaded.map((entry) => entry.event);
      const historical = changes
        .filter((entry) => entry.change.kind === 'present')
        .map((entry) => (entry.change.kind === 'present' ? entry.change.object : null))
        .filter((object): object is RemoteObject => object?.logicalKeyId === input.logicalKeyId);
      if (
        historical.some(
          (object) =>
            object.objectKind !== input.objectKind ||
            object.storedSha256 !== input.storedSha256 ||
            object.sizeBytes !== input.sizeBytes,
        )
      ) {
        throw new ObjectLogProviderError(
          'IMMUTABLE_OBJECT_CONFLICT',
          `Logical key ${input.logicalKeyId} cannot be overwritten with different bytes or metadata`,
        );
      }
      const current = currentByLogicalKey(changes).get(input.logicalKeyId);
      if (current) return { status: 'already-present', object: { ...current } };

      const revision = loaded.length + 1;
      const object: RemoteObject = {
        objectId: createProviderObjectId(`local-folder-object:${revision}`),
        objectKind: input.objectKind,
        logicalKeyId: input.logicalKeyId,
        storedSha256: input.storedSha256,
        sizeBytes: input.sizeBytes,
      };
      const event: LocalFolderDurableChange = {
        revision,
        change: { kind: 'present', object },
      };
      await this.commitEvent(state, event, bytes, input.signal);
      return { status: 'created', object: { ...object } };
    });
  }

  async materializeVerified(
    input: Parameters<LocalFolderObjectTransportPort['materializeVerified']>[0],
  ): Promise<LocalFolderMaterializeResult> {
    const state = this.requireSyncGeneration(input.generation);
    throwIfProviderAborted(input.signal);
    const loaded = await this.loadEvents(state);
    const present = loaded.find(
      (entry) =>
        entry.event.change.kind === 'present' &&
        entry.event.change.object.objectId === input.objectId,
    );
    if (!present || present.event.change.kind !== 'present') {
      throw new ObjectLogProviderError('REMOTE_OBJECT_MISSING', 'Local-folder object is missing');
    }
    const removed = loaded.some(
      (entry) =>
        entry.event.revision > present.event.revision &&
        entry.event.change.kind === 'removed' &&
        entry.event.change.objectId === input.objectId,
    );
    if (removed) {
      throw new ObjectLogProviderError('REMOTE_OBJECT_MISSING', 'Local-folder object was removed');
    }
    const metadata = present.event.change.object;
    if (metadata.storedSha256 !== input.expectedStoredSha256) {
      throw new ObjectLogProviderError('HASH_MISMATCH', 'Expected hash differs from event metadata');
    }
    const objectPath = assertSafeChild(
      assertSafeChild(state.eventsPath, present.directoryName),
      OBJECT_FILE,
    );
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(objectPath));
    } catch {
      throw new ObjectLogProviderError('REMOTE_OBJECT_MISSING', 'Local-folder object bytes are missing');
    }
    const actualHash = await sha256Bytes(bytes);
    if (actualHash !== metadata.storedSha256 || bytes.byteLength !== metadata.sizeBytes) {
      throw new ObjectLogProviderError(
        'HASH_MISMATCH',
        'Local-folder bytes do not match their immutable event metadata',
      );
    }
    throwIfProviderAborted(input.signal);
    await this.localObjects.write(input.destinationRef, bytes, input.signal);
    return {
      destinationRef: input.destinationRef,
      storedSha256: metadata.storedSha256,
      sizeBytes: metadata.sizeBytes,
    };
  }

  /** Test-only degradation seam: provider removal is never a domain deletion. */
  async recordRemoval(generation: LocalFolderTransportSyncGeneration, logicalKeyId: string): Promise<void> {
    const state = this.requireSyncGeneration(generation);
    await this.withSyncGenerationLock(state, async () => {
      const loaded = await this.loadEvents(state);
      const current = currentByLogicalKey(loaded.map((entry) => entry.event)).get(logicalKeyId);
      if (!current) return;
      await this.commitEvent(
        state,
        {
          revision: loaded.length + 1,
          change: { kind: 'removed', objectId: current.objectId, logicalKeyId },
        },
        null,
        new AbortController().signal,
      );
    });
  }

  /** Test-only corruption seam proving verify-before-destination-write. */
  async corruptObject(generation: LocalFolderTransportSyncGeneration, objectId: ProviderObjectId): Promise<void> {
    const state = this.requireSyncGeneration(generation);
    const loaded = await this.loadEvents(state);
    const present = loaded.find(
      (entry) =>
        entry.event.change.kind === 'present' &&
        entry.event.change.object.objectId === objectId,
    );
    if (!present) throw new ObjectLogProviderError('REMOTE_OBJECT_MISSING', 'Object not found');
    const objectPath = assertSafeChild(
      assertSafeChild(state.eventsPath, present.directoryName),
      OBJECT_FILE,
    );
    const bytes = new Uint8Array(await readFile(objectPath));
    const corrupted = bytes.byteLength === 0 ? Uint8Array.of(1) : new Uint8Array(bytes);
    if (bytes.byteLength > 0) corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    await writeFile(objectPath, corrupted);
    await fsyncFile(objectPath);
    await fsyncDirectory(assertSafeChild(state.eventsPath, present.directoryName));
  }

  transportSyncGenerationFor(providerGenerationId: string): LocalFolderTransportSyncGeneration {
    const state = [...this.openGenerations.values()].find(
      (candidate) => candidate.transportSyncGeneration.syncGenerationId === providerGenerationId,
    );
    if (!state) throw new ObjectLogProviderError('INVALID_GENERATION', 'SyncGeneration has not been opened');
    return state.transportSyncGeneration;
  }

  private async commitEvent(
    state: OpenGenerationState,
    event: LocalFolderDurableChange,
    bytes: Uint8Array | null,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfProviderAborted(signal);
    const stageName = `.stage-${event.revision}-${randomUUID()}`;
    const stagePath = assertSafeChild(state.stagingPath, stageName);
    const finalName = `${String(event.revision).padStart(16, '0')}-${
      event.change.kind === 'present'
        ? encodePathComponent(event.change.object.objectId)
        : `removed-${encodePathComponent(event.change.objectId)}`
    }`;
    const finalPath = assertSafeChild(state.eventsPath, finalName);
    let renamed = false;
    try {
      await mkdir(stagePath);
      if (event.change.kind === 'present') {
        if (!bytes) throw new Error('Present event requires bytes');
        await writeNewDurable(assertSafeChild(stagePath, OBJECT_FILE), bytes);
      }
      const persisted: PersistedEvent = {
        format: 'drifting.local-folder.event',
        version: 1,
        revision: event.revision,
        change:
          event.change.kind === 'present'
            ? { kind: 'present', object: { ...event.change.object } }
            : { ...event.change },
      };
      await writeNewDurable(
        assertSafeChild(stagePath, EVENT_FILE),
        `${JSON.stringify(persisted)}\n`,
      );
      await fsyncDirectory(stagePath);
      await fsyncDirectory(state.stagingPath);
      await this.onDurabilityBoundary?.('stage-durable');
      throwIfProviderAborted(signal);
      await rename(stagePath, finalPath);
      renamed = true;
      await this.onDurabilityBoundary?.('commit-renamed');
      await fsyncDirectory(state.eventsPath);
      await fsyncDirectory(state.generationPath);
      await this.onDurabilityBoundary?.('commit-directory-durable');
    } finally {
      if (!renamed) await rm(stagePath, { recursive: true, force: true });
    }
  }

  private async loadEvents(state: OpenGenerationState): Promise<LoadedEvent[]> {
    const names = (await readdir(state.eventsPath)).sort();
    const events: LoadedEvent[] = [];
    for (const name of names) {
      const eventPath = assertSafeChild(assertSafeChild(state.eventsPath, name), EVENT_FILE);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(eventPath, 'utf8'));
      } catch {
        throw new ObjectLogProviderError(
          'REMOTE_STORE_CORRUPT',
          `Committed local-folder event ${name} has unreadable metadata`,
        );
      }
      const event = parsePersistedEvent(parsed);
      if (event.revision !== events.length + 1) {
        throw new ObjectLogProviderError(
          'REMOTE_STORE_CORRUPT',
          `Committed local-folder event revision ${event.revision} is out of sequence`,
        );
      }
      events.push({ directoryName: name, event });
    }
    return events;
  }

  private requireSyncGeneration(generation: LocalFolderTransportSyncGeneration): OpenGenerationState {
    const state = this.openGenerations.get(generation.generationRef);
    if (!state || state.transportSyncGeneration.syncGenerationId !== generation.syncGenerationId) {
      throw new ObjectLogProviderError('INVALID_GENERATION', 'Local-folder transport SyncGeneration is invalid');
    }
    return state;
  }

  private async withSyncGenerationLock<T>(state: OpenGenerationState, work: () => Promise<T>): Promise<T> {
    const key = state.generationPath;
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.locks.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}
