import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../../lib/db';
import {
  BookNodeTable,
  ProjectTable,
  SyncApplyReceiptTable,
  SyncBlobStateTable,
  SyncCursorTable,
  SyncFieldClockTable,
  SyncFrontierGapTable,
  SyncFrontierTable,
  SyncLocalObjectTable,
  SyncProviderBindingTable,
  SyncQuarantinedObjectTable,
  SyncRemoteObjectTable,
  SyncSegmentTable,
  SyncTransferTable,
  SyncGenerationTable,
  yjsUpdates,
} from '../../schema/drizzle';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import {
  productionSyncDomainMaterializationKernel,
  observeLocalAuthoredReducerInTransaction,
  invalidateSqliteReducerStateCache,
  type SyncDomainMaterializationKernel,
} from '../reducer';
import {
  recordAuthoredChangeSetInTransaction,
  SyncChangeBuilder,
  type SyncWriterIdentitySource,
} from '../journal';
import {
  createLocalObjectRef,
  type LocalObjectRef,
  type ObjectLogProvider,
  type ProviderBinding,
  type RemoteObject,
  type Sha256,
  sha256Bytes,
} from '../protocol';
import {
  LocalFolderObjectLogProvider,
  MemoryObjectLogProvider,
  MemoryProviderLocalObjectStore,
} from '../providers';
import { NodeLocalFolderTestTransport } from '../providers/local-folder/node-test-transport';
import {
  PlaintextSyncEngineObjectCodec,
  type PlaintextSyncObjectPort,
} from './plaintext-object-codec';
import {
  SqliteSyncGenerationRuntime,
  type SqliteSyncGenerationRuntimeOptions,
  type SyncEngineRuntimeClock,
} from './durable-runtime';
import { INVENTORY_UNCONFIRMED_CURSOR } from './sqlite-repository';
import type {
  SyncAssetBlobDeclaration,
  SyncEngineBlobPort,
} from './blob-port';

const PROJECT_ID = 'project-engine-e2e';
const SYNC_GENERATION_ID = 'sync-generation-engine-e2e';
const PROJECT_SYNC_ID = 'project-sync-engine-e2e';
const NODE_ID = 'node-engine-e2e';
const DEPENDENT_NODE_ID = 'node-engine-contiguous-dependency';
const NOW = '2026-08-15T12:00:00.000Z';

const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

interface Device {
  readonly id: string;
  readonly db: DbClient;
  readonly gateway: ProductFileBackedSqliteGateway;
  readonly identity: SyncWriterIdentitySource;
  readonly binding: ProviderBinding;
  readonly runtime: SqliteSyncGenerationRuntime;
}

class TestClock implements SyncEngineRuntimeClock {
  constructor(private value: number) {}

  nowMs(): number {
    return this.value;
  }

  nowIso(): string {
    return new Date(this.value).toISOString();
  }

  advance(ms: number): void {
    this.value += ms;
  }
}

class MemoryPlaintextPort implements PlaintextSyncObjectPort {
  private nextRef = 1;

  constructor(
    private readonly prefix: string,
    private readonly objects: MemoryProviderLocalObjectStore,
  ) {}

  allocate(input: {
    syncGenerationId: string;
    purpose: 'outbound' | 'inbound';
    logicalKeyId: string;
  }): LocalObjectRef {
    return this.objects.ref(`${this.prefix}.${input.purpose}.${this.nextRef++}`);
  }

  read(ref: LocalObjectRef, signal: AbortSignal): Promise<Uint8Array> {
    return this.objects.read(ref, signal);
  }

  write(ref: LocalObjectRef, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    return this.objects.write(ref, bytes, signal);
  }
}

class MemoryAssetBlobPort implements SyncEngineBlobPort {
  readonly installedAssetIds = new Set<string>();
  committed = 0;
  rolledBack = 0;

  constructor(
    private readonly objects: MemoryProviderLocalObjectStore,
    private readonly sourceBytes: ReadonlyMap<string, Uint8Array>,
    private readonly failInstall = false,
  ) {}

  async prepareOutbound(input: {
    syncGenerationId: string;
    projectId: string;
    declaration: SyncAssetBlobDeclaration;
  }) {
    const bytes = this.sourceBytes.get(input.declaration.blobId);
    if (!bytes) throw new Error('test canonical source is missing');
    const contentSha256 = await sha256Bytes(bytes);
    if (contentSha256 !== input.declaration.sourceSha256) {
      throw new Error('test canonical source hash mismatch');
    }
    const logicalKeyId = await sha256Bytes(
      new TextEncoder().encode(`blob\0${input.syncGenerationId}\0${input.declaration.blobId}`),
    );
    const sourceRef = this.objects.put(
      `${input.projectId}.${input.declaration.assetId}.outbound`,
      bytes,
    );
    return {
      sourceRef,
      logicalKeyId,
      storedSha256: contentSha256,
      contentSha256,
      sizeBytes: bytes.byteLength,
    };
  }

  async verifyAndInstallInbound(input: {
    syncGenerationId: string;
    projectId: string;
    remoteObject: import('../protocol').RemoteObject;
    sourceRef: LocalObjectRef;
    declarations: readonly SyncAssetBlobDeclaration[];
  }) {
    if (this.failInstall) throw new Error('injected native install failure');
    const bytes = await this.objects.read(input.sourceRef, new AbortController().signal);
    const contentSha256 = await sha256Bytes(bytes);
    const matching = input.declarations.filter(
      (declaration) => declaration.blobId === contentSha256,
    );
    if (matching.length === 0) return null;
    for (const declaration of matching) this.installedAssetIds.add(declaration.assetId);
    return {
      blobId: contentSha256,
      logicalKeyId: input.remoteObject.logicalKeyId,
      contentSha256,
      contentSizeBytes: bytes.byteLength,
      mimeType: matching[0]!.sourceMime,
      installedAssetIds: matching.map(({ assetId }) => assetId),
      commit: async () => {
        this.committed += 1;
      },
      rollback: async () => {
        this.rolledBack += 1;
        for (const declaration of matching) this.installedAssetIds.delete(declaration.assetId);
      },
    };
  }
}

function writerIdentity(deviceId: string): SyncWriterIdentitySource {
  return {
    installationId: `installation-${deviceId}`,
    createWriterIdentity: () => ({
      writerId: `writer-${deviceId}`,
      writerEpoch: `epoch-${deviceId}`,
    }),
  };
}

const nodeKernel: SyncDomainMaterializationKernel = {
  async validate() {
    return [];
  },
  async materialize({ tx, effects }) {
    for (const effect of effects) {
      if (
        !effect.materialize ||
        effect.type !== 'field.set' ||
        effect.target.kind !== 'node' ||
        effect.target.id !== NODE_ID ||
        effect.field !== 'title'
      ) {
        continue;
      }
      if (typeof effect.value !== 'string') throw new TypeError('node title must be a string');
      await tx
        .update(BookNodeTable)
        .set({ title: effect.value })
        .where(eq(BookNodeTable.id, NODE_ID));
    }
  },
};

async function createDatabase(deviceId: string, connectMarker?: RemoteObject): Promise<{
  db: DbClient;
  gateway: ProductFileBackedSqliteGateway;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), `drifting-engine-${deviceId}-`));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: 'local-user',
    name: 'Engine project',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(BookNodeTable).values({
    id: NODE_ID,
    projectId: PROJECT_ID,
    kind: 'chapter',
    title: 'Initial',
    summary: '',
    writingStatus: 'draft',
    positionX: 0,
    positionY: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(SyncGenerationTable).values({
    syncGenerationId: SYNC_GENERATION_ID,
    projectId: PROJECT_ID,
    projectSyncId: PROJECT_SYNC_ID,
    generationNumber: 1,
    protocolVersion: 1,
    domainSchemaVersion: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  gateway.database.prepare(
    `INSERT INTO sync_connect_attempt
      (attempt_id, authority_generation, kind, target_mode,
       target_account_subject_id, target_credential_secret_ref,
       state, created_at, updated_at)
     VALUES ('connect-google', 1, 'connect', 'google-drive',
             'shared-test-account', ?, 'preparing', ?, ?)`,
  ).run(`secret-ref-${deviceId}`, NOW, NOW);
  gateway.database.prepare(
    `UPDATE sync_app_authority
     SET transition_state = 'connecting', target_mode = 'google-drive',
         attempt_id = 'connect-google', updated_at = ?
     WHERE id = 'app'`,
  ).run(NOW);
  const connectMarkerRowId = connectMarker
    ? JSON.stringify(['remote', SYNC_GENERATION_ID, connectMarker.objectId])
    : 'connect-marker';
  gateway.database.prepare(
    `INSERT INTO sync_remote_object
      (id, sync_generation_id, provider_object_id, logical_key_id, object_kind,
       stored_sha256, size_bytes, first_observed_at, last_observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    connectMarkerRowId,
    SYNC_GENERATION_ID,
    connectMarker?.objectId ?? 'connect-provider-marker',
    connectMarker?.logicalKeyId ?? 'connect-logical-marker',
    connectMarker?.objectKind ?? 'snapshot-commit',
    connectMarker ? connectMarker.storedSha256.slice('sha256:'.length) : '0'.repeat(64),
    connectMarker?.sizeBytes ?? 1,
    NOW,
    NOW,
  );
  gateway.database.prepare(
    `INSERT INTO sync_connect_generation_attempt
      (attempt_id, source_sync_generation_id, commit_marker_object_id, state, created_at, updated_at)
     VALUES ('connect-google', ?, ?, 'committed', ?, ?)`,
  ).run(SYNC_GENERATION_ID, connectMarkerRowId, NOW, NOW);
  gateway.database.prepare(
    `UPDATE sync_connect_generation_attempt
     SET state = 'activated', activation_receipt = 'test-activation',
         activated_at = ?, updated_at = ?
     WHERE attempt_id = 'connect-google' AND source_sync_generation_id = ?`,
  ).run(NOW, NOW, SYNC_GENERATION_ID);
  gateway.database.prepare(
    `UPDATE sync_connect_attempt
     SET state = 'completed', completed_at = ?, updated_at = ?
     WHERE attempt_id = 'connect-google'`,
  ).run(NOW, NOW);
  gateway.database.prepare(
    `UPDATE sync_app_authority
     SET mode = 'google-drive', generation = 2, transition_state = 'stable',
         target_mode = NULL, attempt_id = NULL, updated_at = ?
     WHERE id = 'app'`,
  ).run(NOW);
  gateway.database.prepare(
    `INSERT INTO sync_provider_account
      (id, singleton_key, authority_id, provider_kind, authority_generation,
       account_subject_id, credential_secret_ref, created_at, updated_at)
     VALUES (?, 1, 'app', 'google-drive', 2, 'shared-test-account', ?, ?, ?)`,
  ).run(`provider-account-${deviceId}`, `secret-ref-${deviceId}`, NOW, NOW);
  await db.insert(SyncProviderBindingTable).values({
    syncGenerationId: SYNC_GENERATION_ID,
    providerAccountId: `provider-account-${deviceId}`,
    providerNamespace: 'reference-provider',
    state: 'ready',
    connectedAt: NOW,
    updatedAt: NOW,
  });
  return { db, gateway };
}

async function createDevice(input: {
  id: string;
  provider: ObjectLogProvider;
  localObjects: MemoryProviderLocalObjectStore;
  clockMs: number;
  bindingSecretRef?: string | null;
  blobPort?: SyncEngineBlobPort;
  domainKernel?: SyncDomainMaterializationKernel;
  reconcileOpenYjsDocuments?: SqliteSyncGenerationRuntimeOptions['reconcileOpenYjsDocuments'];
  onRemoteChangeCommitted?: SqliteSyncGenerationRuntimeOptions['onRemoteChangeCommitted'];
  connectMarker?: RemoteObject;
}): Promise<Device> {
  const { db, gateway } = await createDatabase(input.id, input.connectMarker);
  const identity = writerIdentity(input.id);
  const binding: ProviderBinding = {
    bindingId: `binding-${input.id}`,
    syncGenerationId: SYNC_GENERATION_ID,
    accountRef: null,
    secretRef: input.bindingSecretRef ?? null,
    authorityGeneration: 2,
  };
  const runtime = new SqliteSyncGenerationRuntime({
    db,
    syncGenerationId: SYNC_GENERATION_ID,
    provider: input.provider,
    providerBinding: binding,
    objectCodec: new PlaintextSyncEngineObjectCodec(
      new MemoryPlaintextPort(input.id, input.localObjects),
    ),
    blobPort: input.blobPort,
    writerIdentity: identity,
    domainKernel: input.domainKernel ?? nodeKernel,
    clock: new TestClock(input.clockMs),
    reconcileOpenYjsDocuments: input.reconcileOpenYjsDocuments,
    onRemoteChangeCommitted: input.onRemoteChangeCommitted,
  });
  return { id: input.id, db, gateway, identity, binding, runtime };
}

async function authorTitle(device: Device, title: string, wallMs: number): Promise<void> {
  invalidateSqliteReducerStateCache();
  const changes = new SyncChangeBuilder();
  changes.add({
    action: 'field.set',
    target: { family: 'entity', kind: 'node', id: NODE_ID, incarnation: 0 },
    payload: { field: 'title', value: title },
  });
  await device.db.transaction(async (tx) => {
    await tx.update(BookNodeTable).set({ title }).where(eq(BookNodeTable.id, NODE_ID));
    const recorded = await recordAuthoredChangeSetInTransaction(tx, {
      projectId: PROJECT_ID,
      projectSyncId: PROJECT_SYNC_ID,
      syncGenerationId: SYNC_GENERATION_ID,
      identity: device.identity,
      clock: { nowMs: wallMs, nowIso: new Date(wallMs).toISOString() },
    }, changes);
    await observeLocalAuthoredReducerInTransaction(tx, {
      changeSet: recorded.changeSet,
      clock: { nowMs: wallMs, nowIso: new Date(wallMs).toISOString() },
    });
  });
}

async function authorProse(device: Device, textValue: string, wallMs: number): Promise<void> {
  invalidateSqliteReducerStateCache();
  const source = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, textValue);
  paragraph.insert(0, [text]);
  source.getXmlFragment('default').insert(0, [paragraph]);
  const update = Y.encodeStateAsUpdate(source);
  source.destroy();
  const docId = `node-content:${NODE_ID}`;
  const changes = new SyncChangeBuilder();
  changes.add({
    action: 'yjs.update',
    target: { family: 'yjs', kind: 'prose-document', id: docId, incarnation: 0 },
    payload: { update },
  });
  await device.db.transaction(async (tx) => {
    await createYjsRepository(tx).appendUpdate(docId, update, { kind: 'user' });
    const recorded = await recordAuthoredChangeSetInTransaction(tx, {
      projectId: PROJECT_ID,
      projectSyncId: PROJECT_SYNC_ID,
      syncGenerationId: SYNC_GENERATION_ID,
      identity: device.identity,
      clock: { nowMs: wallMs, nowIso: new Date(wallMs).toISOString() },
    }, changes);
    await observeLocalAuthoredReducerInTransaction(tx, {
      changeSet: recorded.changeSet,
      clock: { nowMs: wallMs, nowIso: new Date(wallMs).toISOString() },
    });
  });
}

async function authorDependentNodeCreate(
  device: Device,
  titleValue: string,
  wallMs: number,
): Promise<void> {
  invalidateSqliteReducerStateCache();
  const changes = new SyncChangeBuilder();
  changes.add({
    action: 'entity.create',
    target: {
      family: 'entity',
      kind: 'node',
      id: DEPENDENT_NODE_ID,
      incarnation: 0,
    },
    payload: {
      seed: {
        title: titleValue,
        summary: '',
        writingStatus: 'draft',
        kind: 'chapter',
        bookOrder: 3.75,
        positionX: 0,
        positionY: 0,
      },
    },
  });
  await device.db.transaction(async (tx) => {
    const recorded = await recordAuthoredChangeSetInTransaction(tx, {
      projectId: PROJECT_ID,
      projectSyncId: PROJECT_SYNC_ID,
      syncGenerationId: SYNC_GENERATION_ID,
      identity: device.identity,
      clock: { nowMs: wallMs, nowIso: new Date(wallMs).toISOString() },
    }, changes);
    await observeLocalAuthoredReducerInTransaction(tx, {
      changeSet: recorded.changeSet,
      clock: { nowMs: wallMs, nowIso: new Date(wallMs).toISOString() },
    });
  });
}

async function authorDependentNodeTitle(
  device: Device,
  titleValue: string,
  wallMs: number,
): Promise<void> {
  invalidateSqliteReducerStateCache();
  const changes = new SyncChangeBuilder();
  changes.add({
    action: 'field.set',
    target: {
      family: 'entity',
      kind: 'node',
      id: DEPENDENT_NODE_ID,
      incarnation: 0,
    },
    payload: { field: 'title', value: titleValue },
  });
  await device.db.transaction(async (tx) => {
    const recorded = await recordAuthoredChangeSetInTransaction(tx, {
      projectId: PROJECT_ID,
      projectSyncId: PROJECT_SYNC_ID,
      syncGenerationId: SYNC_GENERATION_ID,
      identity: device.identity,
      clock: { nowMs: wallMs, nowIso: new Date(wallMs).toISOString() },
    }, changes);
    await observeLocalAuthoredReducerInTransaction(tx, {
      changeSet: recorded.changeSet,
      clock: { nowMs: wallMs, nowIso: new Date(wallMs).toISOString() },
    });
  });
}

async function authorPdfAsset(
  device: Device,
  input: { assetId: string; sourceSha256: Sha256; sizeBytes: number; wallMs: number },
): Promise<void> {
  const changes = new SyncChangeBuilder();
  changes.add({
    action: 'asset.bind',
    target: {
      family: 'asset',
      kind: 'project-asset',
      id: input.assetId,
      incarnation: 0,
    },
    payload: {
      blobId: input.sourceSha256,
      sourceSha256: input.sourceSha256,
      sourceMime: 'application/pdf',
      sourceSizeBytes: input.sizeBytes,
      kind: 'pdf',
      width: null,
      height: null,
      createdAt: NOW,
      owner: { kind: 'library-item', id: 'library-owner-1' },
    },
  });
  await device.db.transaction(async (tx) => {
    await recordAuthoredChangeSetInTransaction(tx, {
      projectId: PROJECT_ID,
      projectSyncId: PROJECT_SYNC_ID,
      syncGenerationId: SYNC_GENERATION_ID,
      identity: device.identity,
      clock: {
        nowMs: input.wallMs,
        nowIso: new Date(input.wallMs).toISOString(),
      },
    }, changes);
  });
}

async function authorSyncGenerationPurge(device: Device, wallMs: number): Promise<void> {
  const changes = new SyncChangeBuilder();
  changes.add({
    action: 'sync-generation.purge',
    target: {
      family: 'sync-generation',
      kind: 'sync-generation',
      id: SYNC_GENERATION_ID,
      incarnation: 1,
    },
    payload: {},
  });
  await device.db.transaction(async (tx) => {
    await tx.delete(ProjectTable).where(eq(ProjectTable.id, PROJECT_ID));
    await recordAuthoredChangeSetInTransaction(tx, {
      projectId: PROJECT_ID,
      projectSyncId: PROJECT_SYNC_ID,
      syncGenerationId: SYNC_GENERATION_ID,
      identity: device.identity,
      clock: {
        nowMs: wallMs,
        nowIso: new Date(wallMs).toISOString(),
      },
      allowDetachedProject: true,
    }, changes);
  });
}

async function cycle(device: Device, trigger: 'manual' | 'start' = 'manual') {
  invalidateSqliteReducerStateCache();
  return device.runtime.runCycle(new Set([trigger]), new AbortController().signal);
}

async function publishProviderConnectMarker(input: {
  deviceId: string;
  provider: ObjectLogProvider;
  localObjects: MemoryProviderLocalObjectStore;
}): Promise<RemoteObject> {
  const bytes = Uint8Array.of(0xd9, 0x01, 0x00);
  const storedSha256 = await sha256Bytes(bytes);
  const generation = await input.provider.openGeneration({
    bindingId: `binding-${input.deviceId}`,
    syncGenerationId: SYNC_GENERATION_ID,
    accountRef: null,
    secretRef: 'local-folder-root:test',
    authorityGeneration: 2,
  });
  const result = await input.provider.uploadImmutable({
    generation,
    sourceRef: input.localObjects.put(`${input.deviceId}.connect-marker`, bytes),
    objectKind: 'snapshot-commit',
    logicalKeyId: 'fixture-connect-marker',
    storedSha256,
    sizeBytes: bytes.byteLength,
    transferId: `${input.deviceId}.connect-marker`,
    signal: new AbortController().signal,
  });
  return result.object;
}

interface InvalidTokenInjection {
  armed: boolean;
  fired: boolean;
  crashAfterDurableReset?: boolean;
  crashFired?: boolean;
  readonly operation: 'inventory-page' | 'changes-cursor';
  readonly code: 'INVALID_CURSOR' | 'invalid-page-token';
}

function withInvalidTokenInjection(
  base: ObjectLogProvider,
  injection: InvalidTokenInjection,
): ObjectLogProvider {
  const fail = (): never => {
    injection.fired = true;
    throw Object.assign(new Error('injected expired provider token'), { code: injection.code });
  };
  return {
    kind: base.kind,
    openGeneration: (input) => base.openGeneration(input),
    captureStartCursor: (input) => {
      if (
        injection.fired &&
        injection.crashAfterDurableReset &&
        !injection.crashFired
      ) {
        injection.crashFired = true;
        throw new Error('injected crash after durable token reset');
      }
      return base.captureStartCursor(input);
    },
    listInventory: (input) => {
      if (
        injection.armed &&
        !injection.fired &&
        injection.operation === 'inventory-page' &&
        input.pageToken
      ) {
        return fail();
      }
      return base.listInventory(input);
    },
    listChanges: (input) => {
      if (
        injection.armed &&
        !injection.fired &&
        injection.operation === 'changes-cursor' &&
        !input.pageToken
      ) {
        return fail();
      }
      return base.listChanges(input);
    },
    statImmutable: (input) => base.statImmutable(input),
    uploadImmutable: (input) => base.uploadImmutable(input),
    downloadImmutable: (input) => base.downloadImmutable(input),
  };
}

async function title(device: Device): Promise<string | null> {
  return (await device.db
    .select({ value: BookNodeTable.title })
    .from(BookNodeTable)
    .where(eq(BookNodeTable.id, NODE_ID))
    .limit(1))[0]?.value ?? null;
}

function expectHealthy(device: Device): void {
  expect(device.gateway.database.prepare('PRAGMA integrity_check').get()).toEqual({
    integrity_check: 'ok',
  });
  expect(device.gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

afterEach(async () => {
  invalidateSqliteReducerStateCache();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('SQLite durable SyncEngine runtime', () => {
  it('converges two Memory replicas through durable segment, inbox, reducer, cursor and frontier receipts', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects, { pageSize: 1 });
    const a = await createDevice({ id: 'a', provider, localObjects, clockMs: 1_000 });
    const b = await createDevice({ id: 'b', provider, localObjects, clockMs: 2_000 });

    await authorTitle(a, 'From A', 1_000);
    expect((await cycle(a)).publishedSegments).toBe(1);
    await authorTitle(b, 'From B wins', 2_000);
    const bCycle = await cycle(b);
    expect(bCycle.pulledObjects).toBeGreaterThanOrEqual(1);
    expect(bCycle.publishedSegments).toBe(1);
    await cycle(a, 'start');
    await cycle(b, 'start');

    expect(await title(a)).toBe('From B wins');
    expect(await title(b)).toBe('From B wins');
    for (const device of [a, b]) {
      expect(await device.db.select().from(SyncApplyReceiptTable)).toHaveLength(2);
      expect(await device.db.select().from(SyncFieldClockTable)).toMatchObject([
        { changeSetId: 'writer-b:epoch-b:1', hlcWallMs: 2_000 },
      ]);
      expect(await device.db.select().from(SyncFrontierTable)).toHaveLength(2);
      expect(await device.db.select().from(SyncCursorTable)).toHaveLength(1);
      expect(await device.db.select().from(SyncQuarantinedObjectTable)).toEqual([]);
      expect((await device.runtime.inspectPending()).pendingTransfers).toBe(0);
      expectHealthy(device);
    }

    await cycle(a, 'start');
    await cycle(b, 'start');
    expect(await a.db.select().from(SyncApplyReceiptTable)).toHaveLength(2);
    expect(await b.db.select().from(SyncApplyReceiptTable)).toHaveLength(2);
  });

  it('publishes real object and byte progress for outbound and inbound transfers', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects);
    const publisher = await createDevice({
      id: 'progress-publisher',
      provider,
      localObjects,
      clockMs: 1_000,
    });
    const reader = await createDevice({
      id: 'progress-reader',
      provider,
      localObjects,
      clockMs: 2_000,
    });
    const outbound: NonNullable<typeof publisher.runtime.transferProgress>[] = [];
    const inbound: NonNullable<typeof reader.runtime.transferProgress>[] = [];
    const stopPublisher = publisher.runtime.subscribeStatus((runtime) => {
      if (runtime.transferProgress) outbound.push({ ...runtime.transferProgress });
    });
    const stopReader = reader.runtime.subscribeStatus((runtime) => {
      if (runtime.transferProgress) inbound.push({ ...runtime.transferProgress });
    });

    await authorTitle(publisher, 'Progress is visible', 1_000);
    await cycle(publisher);
    await cycle(reader, 'start');

    expect(outbound).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'upload-changes',
          completedObjects: 0,
          totalObjects: 1,
          transferredBytes: 0,
          totalKnown: true,
        }),
        expect.objectContaining({
          stage: 'upload-changes',
          completedObjects: 1,
          totalObjects: 1,
          totalKnown: true,
        }),
      ]),
    );
    expect(inbound).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'download',
          completedObjects: 1,
          totalObjects: 1,
          totalKnown: true,
        }),
      ]),
    );
    const completedOutbound = outbound.find(
      (progress) =>
        progress.stage === 'upload-changes' && progress.completedObjects === 1,
    );
    const completedInbound = inbound.find(
      (progress) => progress.stage === 'download' && progress.completedObjects === 1,
    );
    expect(completedOutbound?.transferredBytes).toBe(completedOutbound?.totalBytes);
    expect(completedInbound?.transferredBytes).toBe(completedInbound?.totalBytes);

    stopPublisher();
    stopReader();
  });

  it('classifies pure remote Yjs as non-blocking and structural effects as workspace-impacting', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects);
    const publisher = await createDevice({
      id: 'projection-impact-publisher',
      provider,
      localObjects,
      clockMs: 2_050,
      domainKernel: productionSyncDomainMaterializationKernel,
    });
    const impacts: Array<'prose-only' | 'workspace'> = [];
    const reader = await createDevice({
      id: 'projection-impact-reader',
      provider,
      localObjects,
      clockMs: 2_060,
      domainKernel: productionSyncDomainMaterializationKernel,
      onRemoteChangeCommitted({ projectionImpact }) {
        impacts.push(projectionImpact);
      },
    });

    await authorProse(publisher, 'remote prose without a workspace barrier', 2_050);
    await cycle(publisher);
    await cycle(reader, 'start');
    expect(impacts).toEqual(['prose-only']);

    await authorTitle(publisher, 'Remote structural title', 2_051);
    await cycle(publisher);
    await cycle(reader, 'start');
    expect(impacts).toEqual(['prose-only', 'workspace']);
  });

  it('retries open Yjs tail reconciliation on the next cycle after a post-commit callback failure', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects);
    const publisher = await createDevice({
      id: 'yjs-callback-publisher',
      provider,
      localObjects,
      clockMs: 2_100,
      domainKernel: productionSyncDomainMaterializationKernel,
    });
    const calls: Array<{ projectId: string; docIds?: readonly string[] }> = [];
    const deliveryOrder: string[] = [];
    let readerDb: DbClient | null = null;
    let failExactDelivery = true;
    const reader = await createDevice({
      id: 'yjs-callback-reader',
      provider,
      localObjects,
      clockMs: 2_200,
      domainKernel: productionSyncDomainMaterializationKernel,
      async reconcileOpenYjsDocuments(input) {
        calls.push(input);
        deliveryOrder.push(input.docIds ? 'exact-yjs' : 'cycle-tail');
        if (input.docIds && failExactDelivery) {
          expect(readerDb).not.toBeNull();
          expect(await readerDb!.select().from(yjsUpdates)).toHaveLength(1);
          expect(await readerDb!.select().from(SyncApplyReceiptTable)).toHaveLength(1);
          failExactDelivery = false;
          throw new Error('simulated post-commit live merge failure');
        }
      },
      onRemoteChangeCommitted({ changeSetId }) {
        deliveryOrder.push(`project-event:${changeSetId}`);
      },
    });
    readerDb = reader.db;

    await authorProse(publisher, 'remote callback prose', 2_100);
    await expect(cycle(publisher)).resolves.toMatchObject({ publishedSegments: 1 });
    await expect(cycle(reader, 'start')).rejects.toThrow(/post-commit live merge failure/u);
    expect(calls).toEqual([
      { projectId: PROJECT_ID },
      { projectId: PROJECT_ID, docIds: [`node-content:${NODE_ID}`] },
    ]);

    // The first transaction already committed its receipt/frontier, so the
    // segment is skipped. The project-wide cycle barrier is what retries the
    // session-owned durable SQLite tail.
    await expect(cycle(reader, 'start')).resolves.toBeDefined();
    expect(calls[2]).toEqual({ projectId: PROJECT_ID });
    expect(await reader.db.select().from(SyncApplyReceiptTable)).toHaveLength(1);

    await authorProse(publisher, 'second remote callback prose', 2_101);
    await expect(cycle(publisher)).resolves.toMatchObject({ publishedSegments: 1 });
    await expect(cycle(reader, 'start')).resolves.toBeDefined();
    const eventIndex = deliveryOrder.findIndex((entry) => entry.startsWith('project-event:'));
    expect(eventIndex).toBeGreaterThan(0);
    expect(deliveryOrder[eventIndex - 1]).toBe('exact-yjs');
  });

  it('keeps a later writer segment dependency-pending until its contiguous predecessor arrives', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects);
    const publisher = await createDevice({
      id: 'contiguous-publisher',
      provider,
      localObjects,
      clockMs: 2_500,
    });

    await authorDependentNodeCreate(publisher, 'Created first', 2_500);
    await expect(cycle(publisher)).resolves.toMatchObject({ publishedSegments: 1 });
    await authorDependentNodeTitle(publisher, 'Updated second', 2_600);
    await expect(cycle(publisher)).resolves.toMatchObject({ publishedSegments: 1 });

    const firstSegment = (await publisher.db
      .select()
      .from(SyncSegmentTable)
      .where(eq(SyncSegmentTable.firstSeq, 1))
      .limit(1))[0];
    expect(firstSegment).toBeDefined();
    const firstObject = (await publisher.db
      .select()
      .from(SyncLocalObjectTable)
      .where(eq(SyncLocalObjectTable.id, firstSegment!.localObjectId))
      .limit(1))[0];
    expect(firstObject).toBeDefined();
    const generation = await provider.openGeneration(publisher.binding);
    expect(provider.removeRemoteObject(generation, firstObject!.logicalKeyId)).not.toBeNull();

    const reader = await createDevice({
      id: 'contiguous-reader',
      provider,
      localObjects,
      clockMs: 2_700,
      domainKernel: productionSyncDomainMaterializationKernel,
    });
    const gapCycle = await cycle(reader, 'start');
    expect(gapCycle.converged).toBe(false);
    expect(await reader.db
      .select()
      .from(BookNodeTable)
      .where(eq(BookNodeTable.id, DEPENDENT_NODE_ID))).toEqual([]);
    expect(await reader.db.select().from(SyncApplyReceiptTable)).toEqual([]);
    expect(await reader.db.select().from(SyncQuarantinedObjectTable)).toEqual([]);
    expect(await reader.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'ready' },
    ]);
    expect(await reader.db.select().from(SyncFrontierTable)).toMatchObject([
      { writerId: 'writer-contiguous-publisher', receivedSeq: 2, appliedSeq: 0 },
    ]);
    expect(await reader.db.select().from(SyncFrontierGapTable)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: 'received', firstSeq: 1, lastSeq: 1, state: 'open' }),
      ]),
    );
    expect(await reader.runtime.inspectPending()).toMatchObject({
      pendingSegments: 1,
      openGaps: 1,
      quarantinedObjects: 0,
    });

    await expect(provider.uploadImmutable({
      generation,
      sourceRef: createLocalObjectRef(firstObject!.storageRef),
      objectKind: 'segment',
      logicalKeyId: firstObject!.logicalKeyId,
      storedSha256: `sha256:${firstObject!.storedSha256}` as Sha256,
      sizeBytes: firstObject!.sizeBytes,
      transferId: 'restore-contiguous-predecessor',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'created' });

    await expect(cycle(reader, 'start')).resolves.toMatchObject({ converged: true });
    expect(await reader.db
      .select({ title: BookNodeTable.title })
      .from(BookNodeTable)
      .where(eq(BookNodeTable.id, DEPENDENT_NODE_ID))).toEqual([
      { title: 'Updated second' },
    ]);
    expect(await reader.db.select().from(SyncApplyReceiptTable)).toHaveLength(2);
    expect(await reader.db.select().from(SyncQuarantinedObjectTable)).toEqual([]);
    expect(await reader.db.select().from(SyncFrontierTable)).toMatchObject([
      { writerId: 'writer-contiguous-publisher', receivedSeq: 2, appliedSeq: 2 },
    ]);
    expect(await reader.runtime.inspectPending()).toMatchObject({
      pendingSegments: 0,
      openGaps: 0,
      quarantinedObjects: 0,
    });

    await cycle(reader, 'start');
    expect(await reader.db.select().from(SyncApplyReceiptTable)).toHaveLength(2);
    expectHealthy(reader);
  });

  it('uses a restored applied segment-head anchor to accept the next segment and quarantine a fork', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects);
    const publisher = await createDevice({
      id: 'checkpoint-anchor-publisher',
      provider,
      localObjects,
      clockMs: 2_800,
    });

    await authorTitle(publisher, 'Checkpoint state', 2_800);
    await expect(cycle(publisher)).resolves.toMatchObject({ publishedSegments: 1 });
    await authorTitle(publisher, 'After checkpoint', 2_900);
    await expect(cycle(publisher)).resolves.toMatchObject({ publishedSegments: 1 });
    const sourceSegments = await publisher.db
      .select()
      .from(SyncSegmentTable)
      .orderBy(SyncSegmentTable.firstSeq);
    expect(sourceSegments).toHaveLength(2);
    const [firstSegment, secondSegment] = sourceSegments;
    const [firstObject] = await publisher.db
      .select()
      .from(SyncLocalObjectTable)
      .where(eq(SyncLocalObjectTable.id, firstSegment!.localObjectId))
      .limit(1);
    const generation = await provider.openGeneration(publisher.binding);
    expect(provider.removeRemoteObject(generation, firstObject!.logicalKeyId)).not.toBeNull();

    const seedCheckpointFrontier = async (device: Device, head: string) => {
      await device.db
        .update(BookNodeTable)
        .set({ title: 'Checkpoint state' })
        .where(eq(BookNodeTable.id, NODE_ID));
      await device.db.insert(SyncFrontierTable).values({
        syncGenerationId: SYNC_GENERATION_ID,
        writerId: 'writer-checkpoint-anchor-publisher',
        writerEpoch: 'epoch-checkpoint-anchor-publisher',
        receivedSeq: 1,
        appliedSeq: 1,
        publishedSeq: 1,
        segmentHeadSha256: head,
        updatedAt: NOW,
      });
    };

    const restored = await createDevice({
      id: 'checkpoint-anchor-restored',
      provider,
      localObjects,
      clockMs: 3_000,
    });
    await seedCheckpointFrontier(restored, firstSegment!.segmentSha256);
    await expect(cycle(restored, 'start')).resolves.toMatchObject({
      pulledObjects: 1,
      publishedSegments: 0,
      converged: true,
    });
    expect(await title(restored)).toBe('After checkpoint');
    expect(await restored.db.select().from(SyncFrontierTable)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          writerId: 'writer-checkpoint-anchor-publisher',
          appliedSeq: 2,
          segmentHeadSha256: secondSegment!.segmentSha256,
        }),
      ]),
    );
    expect(await restored.db.select().from(SyncQuarantinedObjectTable)).toEqual([]);
    expect((await provider.listInventory({ generation })).objects).toHaveLength(1);

    const forked = await createDevice({
      id: 'checkpoint-anchor-forked',
      provider,
      localObjects,
      clockMs: 3_100,
    });
    await seedCheckpointFrontier(forked, 'f'.repeat(64));
    await expect(cycle(forked, 'start')).resolves.toMatchObject({
      pulledObjects: 1,
      publishedSegments: 0,
      converged: false,
    });
    expect(await title(forked)).toBe('Checkpoint state');
    expect(await forked.db.select().from(SyncQuarantinedObjectTable)).toMatchObject([
      {
        reason: 'segment previous hash does not match the applied checkpoint frontier',
        state: 'blocked-corrupt',
      },
    ]);
    expect(await forked.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'blocked-corrupt' },
    ]);
    expectHealthy(restored);
    expectHealthy(forked);
  });

  it('reconciles an upload response loss by immutable stat without duplicating the object', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const base = new MemoryObjectLogProvider(localObjects, { pageSize: 1 });
    let loseFirstResponse = true;
    const observedTransferIds: string[] = [];
    const provider: ObjectLogProvider = {
      kind: base.kind,
      openGeneration: (binding) => base.openGeneration(binding),
      captureStartCursor: (generation) => base.captureStartCursor(generation),
      listInventory: (input) => base.listInventory(input),
      listChanges: (input) => base.listChanges(input),
      statImmutable: (input) => base.statImmutable(input),
      async uploadImmutable(input) {
        observedTransferIds.push(input.transferId);
        const result = await base.uploadImmutable(input);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw Object.assign(new Error('simulated response loss'), { code: 'TRANSIENT' });
        }
        return result;
      },
      downloadImmutable: (input) => base.downloadImmutable(input),
    };
    const device = await createDevice({ id: 'loss', provider, localObjects, clockMs: 3_000 });
    await authorTitle(device, 'Survives response loss', 3_000);

    await expect(cycle(device)).rejects.toThrow(/response loss/u);
    expect(observedTransferIds).toEqual([expect.stringMatching(/^upload-[0-9a-f]{64}$/u)]);
    expect(await device.db.select().from(SyncTransferTable)).toMatchObject([
      { direction: 'upload', state: 'retry-wait', attemptCount: 1 },
    ]);
    await expect(cycle(device)).resolves.toMatchObject({ publishedSegments: 1 });
    expect(await device.db.select().from(SyncTransferTable)).toMatchObject([
      { direction: 'upload', state: 'completed', attemptCount: 2 },
    ]);
    expect(await device.db.select().from(SyncSegmentTable)).toMatchObject([
      { state: 'published' },
    ]);
    const generation = await base.openGeneration(device.binding);
    expect((await base.listInventory({ generation })).objects).toHaveLength(1);
    expectHealthy(device);
  });

  it('blocks a degraded provider history without turning remote removal into a domain delete', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects);
    const publisher = await createDevice({
      id: 'removal-publisher',
      provider,
      localObjects,
      clockMs: 4_000,
    });
    const reader = await createDevice({
      id: 'removal-reader',
      provider,
      localObjects,
      clockMs: 5_000,
    });
    await authorTitle(publisher, 'Remote history remains authored', 4_000);
    await cycle(publisher);
    await cycle(reader, 'start');
    expect(await title(reader)).toBe('Remote history remains authored');

    const generation = await provider.openGeneration(publisher.binding);
    const [remote] = (await provider.listInventory({ generation })).objects;
    expect(remote).toBeDefined();
    expect(provider.removeRemoteObject(generation, remote!.logicalKeyId)).not.toBeNull();
    await authorTitle(reader, 'Local edit stays pending after degradation', 5_001);

    await expect(cycle(reader, 'start')).rejects.toThrow(/removed.*immutable object/u);
    expect(await title(reader)).toBe('Local edit stays pending after degradation');
    expect(await reader.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'blocked-corrupt' },
    ]);
    expect(await reader.runtime.inspectPending()).toMatchObject({
      quarantinedObjects: 1,
    });
    expect((await provider.listInventory({ generation })).objects).toEqual([]);
    await expect(cycle(reader, 'start')).resolves.toMatchObject({
      pulledObjects: 0,
      publishedBlobs: 0,
      publishedSegments: 0,
      converged: false,
    });
    expect((await provider.listInventory({ generation })).objects).toEqual([]);
    expectHealthy(reader);
  });

  it('converges three LocalFolder replicas and replays a page after a cursor-commit crash', async () => {
    const folderRoot = await mkdtemp(path.join(tmpdir(), 'drifting-engine-local-folder-'));
    temporaryDirectories.push(folderRoot);
    const localA = new MemoryProviderLocalObjectStore();
    const localB = new MemoryProviderLocalObjectStore();
    const localC = new MemoryProviderLocalObjectStore();
    const a = await createDevice({
      id: 'folder-a',
      provider: new LocalFolderObjectLogProvider(
        new NodeLocalFolderTestTransport(folderRoot, localA),
        { pageSize: 1 },
      ),
      localObjects: localA,
      clockMs: 10_000,
      bindingSecretRef: 'local-folder-root:test',
    });
    const b = await createDevice({
      id: 'folder-b',
      provider: new LocalFolderObjectLogProvider(
        new NodeLocalFolderTestTransport(folderRoot, localB),
        { pageSize: 1 },
      ),
      localObjects: localB,
      clockMs: 20_000,
      bindingSecretRef: 'local-folder-root:test',
    });
    const c = await createDevice({
      id: 'folder-c',
      provider: new LocalFolderObjectLogProvider(
        new NodeLocalFolderTestTransport(folderRoot, localC),
        { pageSize: 1 },
      ),
      localObjects: localC,
      clockMs: 30_000,
      bindingSecretRef: 'local-folder-root:test',
    });

    await authorTitle(a, 'Folder A', 10_000);
    await cycle(a);

    let cursorWrites = 0;
    b.gateway.failNextExecute((statement) => {
      if (!statement.includes('sync_cursor')) return false;
      cursorWrites += 1;
      return cursorWrites === 2;
    });
    await expect(cycle(b)).rejects.toThrow(/sync_cursor/u);
    expect(await b.db.select().from(SyncApplyReceiptTable)).toHaveLength(0);
    expect(await b.db.select().from(SyncTransferTable)).toMatchObject([
      { direction: 'download', state: 'completed' },
    ]);

    await authorTitle(b, 'Folder B', 20_000);
    await cycle(b);
    await authorTitle(c, 'Folder C wins', 30_000);
    await cycle(c);
    await cycle(a, 'start');
    await cycle(b, 'start');
    await cycle(c, 'start');

    for (const device of [a, b, c]) {
      expect(await title(device)).toBe('Folder C wins');
      expect(await device.db.select().from(SyncApplyReceiptTable)).toHaveLength(3);
      expect(await device.db.select().from(SyncFrontierTable)).toHaveLength(3);
      expect(await device.db.select().from(SyncQuarantinedObjectTable)).toEqual([]);
      expect(await device.runtime.inspectPending()).toEqual({
        pendingChangeSets: 0,
        pendingSegments: 0,
        pendingTransfers: 0,
        openGaps: 0,
        openConflicts: 0,
        quarantinedObjects: 0,
      });
      expectHealthy(device);
    }
  });

  it('recovers an expired committed LocalFolder cursor through a durable full inventory', async () => {
    const folderRoot = await mkdtemp(path.join(tmpdir(), 'drifting-engine-expired-cursor-'));
    temporaryDirectories.push(folderRoot);
    const publisherObjects = new MemoryProviderLocalObjectStore();
    const readerObjects = new MemoryProviderLocalObjectStore();
    const publisherProvider = new LocalFolderObjectLogProvider(
      new NodeLocalFolderTestTransport(folderRoot, publisherObjects),
      { pageSize: 1 },
    );
    const readerBase = new LocalFolderObjectLogProvider(
      new NodeLocalFolderTestTransport(folderRoot, readerObjects),
      { pageSize: 1 },
    );
    const injection: InvalidTokenInjection = {
      armed: false,
      fired: false,
      operation: 'changes-cursor',
      code: 'INVALID_CURSOR',
    };
    const publisher = await createDevice({
      id: 'expired-cursor-publisher',
      provider: publisherProvider,
      localObjects: publisherObjects,
      clockMs: 11_000,
      bindingSecretRef: 'local-folder-root:test',
    });
    const readerConnectMarker = await publishProviderConnectMarker({
      deviceId: 'expired-cursor-reader',
      provider: readerBase,
      localObjects: readerObjects,
    });
    const reader = await createDevice({
      id: 'expired-cursor-reader',
      provider: withInvalidTokenInjection(readerBase, injection),
      localObjects: readerObjects,
      clockMs: 12_000,
      bindingSecretRef: 'local-folder-root:test',
      connectMarker: readerConnectMarker,
    });
    await authorTitle(publisher, 'Before cursor expiry', 11_000);
    await expect(cycle(publisher)).resolves.toMatchObject({ publishedSegments: 1 });
    await cycle(reader, 'start');
    expect(await title(reader)).toBe('Before cursor expiry');

    await authorTitle(publisher, 'After cursor expiry', 11_001);
    await expect(cycle(publisher)).resolves.toMatchObject({ publishedSegments: 1 });
    injection.armed = true;
    await expect(cycle(reader, 'start')).resolves.toMatchObject({ converged: true });

    expect(injection.fired).toBe(true);
    expect(await title(reader)).toBe('After cursor expiry');
    expect(await reader.db.select().from(SyncCursorTable)).toMatchObject([
      { inventoryComplete: true, pendingPageToken: null },
    ]);
    expect(
      await reader.db
        .select()
        .from(SyncRemoteObjectTable)
        .where(eq(SyncRemoteObjectTable.observedCursor, INVENTORY_UNCONFIRMED_CURSOR)),
    ).toEqual([]);
    expect(await reader.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'ready' },
    ]);
    expectHealthy(reader);
  });

  it('recovers an expired lowercase Drive-style pending inventory page token', async () => {
    const folderRoot = await mkdtemp(path.join(tmpdir(), 'drifting-engine-expired-page-'));
    temporaryDirectories.push(folderRoot);
    const publisherObjects = new MemoryProviderLocalObjectStore();
    const readerObjects = new MemoryProviderLocalObjectStore();
    const publisherProvider = new LocalFolderObjectLogProvider(
      new NodeLocalFolderTestTransport(folderRoot, publisherObjects),
      { pageSize: 1 },
    );
    const readerBase = new LocalFolderObjectLogProvider(
      new NodeLocalFolderTestTransport(folderRoot, readerObjects),
      { pageSize: 1 },
    );
    const injection: InvalidTokenInjection = {
      armed: true,
      fired: false,
      crashAfterDurableReset: true,
      operation: 'inventory-page',
      code: 'invalid-page-token',
    };
    const publisher = await createDevice({
      id: 'expired-page-publisher',
      provider: publisherProvider,
      localObjects: publisherObjects,
      clockMs: 13_000,
      bindingSecretRef: 'local-folder-root:test',
    });
    await authorTitle(publisher, 'First inventory page', 13_000);
    await expect(cycle(publisher)).resolves.toMatchObject({ publishedSegments: 1 });
    await authorTitle(publisher, 'Second inventory page wins', 13_001);
    await expect(cycle(publisher)).resolves.toMatchObject({ publishedSegments: 1 });

    const readerConnectMarker = await publishProviderConnectMarker({
      deviceId: 'expired-page-reader',
      provider: readerBase,
      localObjects: readerObjects,
    });
    const reader = await createDevice({
      id: 'expired-page-reader',
      provider: withInvalidTokenInjection(readerBase, injection),
      localObjects: readerObjects,
      clockMs: 14_000,
      bindingSecretRef: 'local-folder-root:test',
      connectMarker: readerConnectMarker,
    });
    await expect(cycle(reader, 'start')).rejects.toThrow(
      'injected crash after durable token reset',
    );
    expect(await reader.db.select().from(SyncCursorTable)).toEqual([]);
    expect(
      await reader.db
        .select()
        .from(SyncRemoteObjectTable)
        .where(eq(SyncRemoteObjectTable.observedCursor, INVENTORY_UNCONFIRMED_CURSOR)),
    ).toHaveLength(1);

    await expect(cycle(reader, 'start')).resolves.toMatchObject({ converged: true });

    expect(injection.fired).toBe(true);
    expect(injection.crashFired).toBe(true);
    expect(await title(reader)).toBe('Second inventory page wins');
    expect(await reader.db.select().from(SyncCursorTable)).toMatchObject([
      { inventoryComplete: true, pendingPageToken: null },
    ]);
    expect(
      await reader.db
        .select()
        .from(SyncRemoteObjectTable)
        .where(eq(SyncRemoteObjectTable.observedCursor, INVENTORY_UNCONFIRMED_CURSOR)),
    ).toEqual([]);
    expectHealthy(reader);
  });

  it('blocks before publish when an invalid cursor rescan omits a known immutable object', async () => {
    const folderRoot = await mkdtemp(path.join(tmpdir(), 'drifting-engine-rescan-missing-'));
    temporaryDirectories.push(folderRoot);
    const publisherObjects = new MemoryProviderLocalObjectStore();
    const readerObjects = new MemoryProviderLocalObjectStore();
    const publisherTransport = new NodeLocalFolderTestTransport(folderRoot, publisherObjects);
    const publisherProvider = new LocalFolderObjectLogProvider(publisherTransport, { pageSize: 1 });
    const readerBase = new LocalFolderObjectLogProvider(
      new NodeLocalFolderTestTransport(folderRoot, readerObjects),
      { pageSize: 1 },
    );
    const injection: InvalidTokenInjection = {
      armed: false,
      fired: false,
      operation: 'changes-cursor',
      code: 'INVALID_CURSOR',
    };
    const publisher = await createDevice({
      id: 'rescan-missing-publisher',
      provider: publisherProvider,
      localObjects: publisherObjects,
      clockMs: 15_000,
      bindingSecretRef: 'local-folder-root:test',
    });
    const readerConnectMarker = await publishProviderConnectMarker({
      deviceId: 'rescan-missing-reader',
      provider: readerBase,
      localObjects: readerObjects,
    });
    const reader = await createDevice({
      id: 'rescan-missing-reader',
      provider: withInvalidTokenInjection(readerBase, injection),
      localObjects: readerObjects,
      clockMs: 16_000,
      bindingSecretRef: 'local-folder-root:test',
      connectMarker: readerConnectMarker,
    });
    await authorTitle(publisher, 'Remote immutable history', 15_000);
    await expect(cycle(publisher)).resolves.toMatchObject({ publishedSegments: 1 });
    await cycle(reader, 'start');
    const publisherSyncGeneration = await publisherProvider.openGeneration(publisher.binding);
    const [remote] = await reader.db
      .select({ logicalKeyId: SyncRemoteObjectTable.logicalKeyId })
      .from(SyncRemoteObjectTable)
      .where(eq(SyncRemoteObjectTable.objectKind, 'segment'))
      .limit(1);
    expect(remote).toBeDefined();
    await publisherTransport.recordRemoval(
      publisherTransport.transportSyncGenerationFor(SYNC_GENERATION_ID),
      remote!.logicalKeyId,
    );
    await authorTitle(reader, 'Pending local edit must not publish', 16_001);
    injection.armed = true;

    await expect(cycle(reader, 'start')).rejects.toThrow(/inventory omitted.*immutable object/u);
    expect(injection.fired).toBe(true);
    expect(await reader.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'blocked-corrupt' },
    ]);
    expect(await reader.runtime.inspectPending()).toMatchObject({
      pendingChangeSets: 1,
      quarantinedObjects: 1,
    });
    expect(
      (await publisherProvider.listInventory({ generation: publisherSyncGeneration })).objects.map(
        ({ objectKind }) => objectKind,
      ),
    ).toEqual(['snapshot-commit']);
    await expect(cycle(reader, 'start')).resolves.toMatchObject({
      pulledObjects: 0,
      publishedSegments: 0,
      converged: false,
    });
    expect(
      (await publisherProvider.listInventory({ generation: publisherSyncGeneration })).objects.map(
        ({ objectKind }) => objectKind,
      ),
    ).toEqual(['snapshot-commit']);
    expectHealthy(reader);
  });

  it('durably quarantines malformed protocol bytes and advances discovery without domain writes', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects, { pageSize: 1 });
    const malformed = Uint8Array.of(0xff, 0x00, 0x01);
    const binding: ProviderBinding = {
      bindingId: 'binding-malformed-publisher',
      syncGenerationId: SYNC_GENERATION_ID,
      accountRef: null,
      secretRef: null,
      authorityGeneration: 2,
    };
    const generation = await provider.openGeneration(binding);
    const sourceRef = localObjects.put('malformed.segment', malformed);
    await provider.uploadImmutable({
      generation,
      sourceRef,
      objectKind: 'segment',
      logicalKeyId: 'malformed-segment-logical-key',
      storedSha256: await sha256Bytes(malformed),
      sizeBytes: malformed.byteLength,
      transferId: 'malformed-upload',
      signal: new AbortController().signal,
    });
    const device = await createDevice({
      id: 'malformed-reader',
      provider,
      localObjects,
      clockMs: 40_000,
    });

    const result = await cycle(device);
    expect(result.converged).toBe(false);
    expect(await title(device)).toBe('Initial');
    expect(await device.db.select().from(SyncApplyReceiptTable)).toEqual([]);
    expect(await device.db.select().from(SyncQuarantinedObjectTable)).toMatchObject([
      { state: 'blocked-corrupt' },
    ]);
    expect(await device.db.select().from(SyncLocalObjectTable)).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'quarantined' })]),
    );
    expect(await device.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'blocked-corrupt' },
    ]);
    expect(await device.db.select().from(SyncCursorTable)).toHaveLength(1);
    expectHealthy(device);
  });

  it('keeps authored writes pending without provider I/O while a binding is paused', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects);
    const device = await createDevice({
      id: 'paused',
      provider,
      localObjects,
      clockMs: 50_000,
    });
    await device.db
      .update(SyncProviderBindingTable)
      .set({ state: 'paused', updatedAt: NOW })
      .where(eq(SyncProviderBindingTable.syncGenerationId, SYNC_GENERATION_ID));
    await authorTitle(device, 'Local while paused', 50_000);

    await expect(cycle(device)).resolves.toMatchObject({
      pulledObjects: 0,
      publishedSegments: 0,
      converged: false,
    });
    expect(await title(device)).toBe('Local while paused');
    expect(await device.db.select().from(SyncCursorTable)).toEqual([]);
    expect(await device.db.select().from(SyncSegmentTable)).toEqual([]);
    expect(await device.runtime.inspectPending()).toMatchObject({ pendingChangeSets: 1 });

    await device.db
      .update(SyncProviderBindingTable)
      .set({ state: 'ready', updatedAt: NOW })
      .where(eq(SyncProviderBindingTable.syncGenerationId, SYNC_GENERATION_ID));
    await expect(cycle(device)).resolves.toMatchObject({ publishedSegments: 1 });
    expect(await device.runtime.inspectPending()).toMatchObject({ pendingChangeSets: 0 });
    expectHealthy(device);
  });

  it('publishes a detached project purge before retiring the SyncGeneration binding', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects);
    const device = await createDevice({
      id: 'purge-publisher',
      provider,
      localObjects,
      clockMs: 55_000,
    });
    await authorSyncGenerationPurge(device, 55_000);
    expect(await device.db.select().from(SyncGenerationTable)).toMatchObject([
      { projectId: null, status: 'active' },
    ]);

    await expect(cycle(device)).resolves.toMatchObject({ publishedSegments: 1 });

    expect(await device.db.select().from(SyncGenerationTable)).toMatchObject([
      { projectId: null, status: 'purged', purgedAt: new Date(55_000).toISOString() },
    ]);
    expect(await device.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'purged' },
    ]);
    const generation = await provider.openGeneration(device.binding);
    expect((await provider.listInventory({ generation })).objects).toHaveLength(1);
    await expect(cycle(device, 'start')).resolves.toMatchObject({
      pulledObjects: 0,
      publishedSegments: 0,
      converged: false,
    });
    expectHealthy(device);
  });

  it('receipts a later writer after remote purge and retires the current binding', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects);
    const laterWriter = await createDevice({
      id: 'z-after-purge',
      provider,
      localObjects,
      clockMs: 56_001,
    });
    await authorTitle(laterWriter, 'Must not survive purge', 56_001);
    await cycle(laterWriter);

    const purgeWriter = await createDevice({
      id: 'a-purge-first',
      provider,
      localObjects,
      clockMs: 56_000,
    });
    await authorSyncGenerationPurge(purgeWriter, 56_000);
    await cycle(purgeWriter);

    const receiver = await createDevice({
      id: 'purge-receiver',
      provider,
      localObjects,
      clockMs: 57_000,
      domainKernel: productionSyncDomainMaterializationKernel,
    });
    await cycle(receiver);

    expect(await receiver.db.select().from(ProjectTable)).toEqual([]);
    expect(await receiver.db.select().from(SyncApplyReceiptTable)).toHaveLength(2);
    expect(await receiver.db.select().from(SyncGenerationTable)).toMatchObject([
      { projectId: null, status: 'purged' },
    ]);
    expect(await receiver.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'purged' },
    ]);
    expectHealthy(receiver);
  });

  it('publishes blobs before dependent segments and installs a verified source before owner materialization', async () => {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects);
    const bytes = new TextEncoder().encode('%PDF-1.7\nSyncEngine asset\n%%EOF');
    const sourceSha256 = await sha256Bytes(bytes);
    const sources = new Map([[sourceSha256, bytes]]);
    const publisherBlobPort = new MemoryAssetBlobPort(localObjects, sources);
    const publisher = await createDevice({
      id: 'asset-publisher',
      provider,
      localObjects,
      blobPort: publisherBlobPort,
      clockMs: 60_000,
    });
    await authorPdfAsset(publisher, {
      assetId: 'asset-pdf-1',
      sourceSha256,
      sizeBytes: bytes.byteLength,
      wallMs: 60_000,
    });

    await expect(cycle(publisher)).resolves.toMatchObject({
      publishedBlobs: 1,
      publishedSegments: 1,
    });
    expect(await publisher.db.select().from(SyncBlobStateTable)).toMatchObject([
      { localState: 'verified', remoteState: 'available' },
    ]);

    const readerBlobPort = new MemoryAssetBlobPort(localObjects, sources);
    let ownerMaterialized = false;
    const readerKernel: SyncDomainMaterializationKernel = {
      externallyMaterializedActions: new Set(['asset.bind']),
      async validate(context) {
        const blob = await context.tx
          .select({ localState: SyncBlobStateTable.localState })
          .from(SyncBlobStateTable)
          .where(eq(SyncBlobStateTable.syncGenerationId, SYNC_GENERATION_ID));
        if (
          blob[0]?.localState !== 'verified' ||
          !readerBlobPort.installedAssetIds.has('asset-pdf-1')
        ) {
          throw new Error('owner validation ran before native blob install and SQLite verification');
        }
        return [];
      },
      async materialize({ effects }) {
        if (effects.some((effect) => effect.type === 'asset.bind' && effect.materialize)) {
          ownerMaterialized = true;
        }
      },
    };
    const reader = await createDevice({
      id: 'asset-reader',
      provider,
      localObjects,
      blobPort: readerBlobPort,
      domainKernel: readerKernel,
      clockMs: 61_000,
    });
    await cycle(reader, 'start');

    expect(readerBlobPort.installedAssetIds).toContain('asset-pdf-1');
    expect(readerBlobPort.committed).toBe(1);
    expect(readerBlobPort.rolledBack).toBe(0);
    expect(ownerMaterialized).toBe(true);
    expect(await reader.db.select().from(SyncBlobStateTable)).toMatchObject([
      {
        blobId: sourceSha256,
        localState: 'verified',
        remoteState: 'available',
      },
    ]);
    expect(await reader.db.select().from(SyncApplyReceiptTable)).toHaveLength(1);
    expectHealthy(reader);

    const failingBlobPort = new MemoryAssetBlobPort(localObjects, sources, true);
    let failedOwnerMaterialized = false;
    const failedReader = await createDevice({
      id: 'asset-failed-reader',
      provider,
      localObjects,
      blobPort: failingBlobPort,
      domainKernel: {
        externallyMaterializedActions: new Set(['asset.bind']),
        async validate() {
          return [];
        },
        async materialize() {
          failedOwnerMaterialized = true;
        },
      },
      clockMs: 62_000,
    });
    await cycle(failedReader, 'start');
    expect(failedOwnerMaterialized).toBe(false);
    expect(await failedReader.db.select().from(SyncApplyReceiptTable)).toEqual([]);
    expect(await failedReader.db.select().from(SyncBlobStateTable)).toEqual([]);
    expect(await failedReader.db.select().from(SyncQuarantinedObjectTable)).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'blocked-corrupt' })]),
    );
    expectHealthy(failedReader);
  });
});
