import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../../lib/db';
import {
  ProjectTable,
  SyncAppAuthorityTable,
  SyncApplyReceiptTable,
  SyncCheckpointTable,
  SyncConnectAttemptTable,
  SyncConnectGenerationAttemptTable,
  SyncCursorTable,
  SyncLocalObjectTable,
  SyncProviderBindingTable,
  SyncRemoteObjectTable,
  SyncRestoreAttemptTable,
  SyncGenerationTable,
} from '../../schema/drizzle';
import { captureSnapshotV1 } from '../checkpoint';
import { SqliteSyncGenerationRuntime } from '../engine/durable-runtime';
import { PlaintextSyncEngineObjectCodec } from '../engine/plaintext-object-codec';
import { recordAuthoredChangeSetInTransaction, SyncChangeBuilder } from '../journal';
import { productionSyncDomainMaterializationKernel } from '../reducer';
import {
  compareUtf8Bytewise,
  encodeSegmentV1,
  encodeSnapshotCommitMarkerV1,
  sha256Bytes,
  type ObjectLogProvider,
  type ProviderGeneration,
  type RemoteObject,
} from '../protocol';
import { MemoryObjectLogProvider } from '../providers/memory-provider';
import { MemoryProviderLocalObjectStore } from '../providers/local-object-store';
import {
  discoverCurrentSyncGenerationObjects,
  restoreGoogleDriveSyncGenerations,
  type GoogleDriveRestoreDependencies,
  type RestoreObjectAccess,
} from './google-drive-restore';

const NOW = '2026-08-15T12:00:00.000Z';
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

function restoredWriterIdentity(label: string) {
  return {
    installationId: `installation-${label}`,
    createWriterIdentity: () => ({
      writerId: `writer-${label}`,
      writerEpoch: `epoch-${label}`,
    }),
  };
}

async function database(label: string): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), `drifting-drive-restore-${label}-`));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  return gateway.client();
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function plaintextAccess(
  codec: PlaintextSyncEngineObjectCodec,
): RestoreObjectAccess {
  return {
    async decodeProtocol(input) {
      const sourceRef = await codec.allocateInbound({
        syncGenerationId: input.generation.syncGenerationId,
        remoteObject: input.remoteObject,
      });
      await input.provider.downloadImmutable({
        generation: input.generation,
        objectId: input.remoteObject.objectId,
        destinationRef: sourceRef,
        expectedStoredSha256: input.remoteObject.storedSha256,
        transferId: input.transferId,
        signal: input.signal,
      });
      const decoded = await codec.decodeInbound({
        syncGenerationId: input.generation.syncGenerationId,
        expectedLogicalKeyId: input.remoteObject.logicalKeyId,
        remoteObject: input.remoteObject,
        sourceRef,
      });
      return { bytes: decoded.protocolBytes, sourceRef, contentSha256: decoded.contentSha256 };
    },
    async deriveBlobLogicalKey({ syncGenerationId, blobId }) {
      const digest = await sha256Bytes(
        new TextEncoder().encode(`blob/${syncGenerationId}/${blobId}`),
      );
      return digest;
    },
    async decodeBlob(input) {
      const decoded = await this.decodeProtocol(input);
      return {
        sourceRef: decoded.sourceRef,
        contentSha256: decoded.contentSha256,
        sizeBytes: decoded.bytes.byteLength,
      };
    },
  };
}

function discoveryFor(
  provider: MemoryObjectLogProvider,
  generation: ProviderGeneration,
): GoogleDriveRestoreDependencies['discovery'] {
  return {
    async discover() {
      const inventory = await provider.listInventory({ generation });
      return inventory.objects
        .filter(
          (object): object is RemoteObject & { readonly objectKind: 'snapshot-commit' } =>
            object.objectKind === 'snapshot-commit',
        )
        .map((object) => ({ syncGenerationId: generation.syncGenerationId, object }));
    },
  };
}

const claimSameAccount: GoogleDriveRestoreDependencies['claimAccount'] = async (
  credentialSecretRef,
  accountSubject,
) => ({ credentialSecretRef, accountSubject });

async function publishRemoteGenesis(input: {
  db: DbClient;
  provider: MemoryObjectLogProvider;
  codec: PlaintextSyncEngineObjectCodec;
  providerGeneration: ProviderGeneration;
  signal: AbortSignal;
}) {
  const captured = await captureSnapshotV1({
    db: input.db,
    projectId: 'remote-project',
    syncGenerationId: 'remote-generation',
    snapshotId: 'genesis-remote',
    snapshotKind: 'genesis',
    packageLogicalKeyId: 'pending-package-key',
    capturedAt: { wallMs: 100, counter: 0 },
    committedAt: { wallMs: 101, counter: 0 },
  });
  const preparedPackage = await input.codec.prepareOutbound({
    syncGenerationId: 'remote-generation',
    objectKind: 'genesis',
    canonicalLogicalKey: 'snapshot/remote-generation/genesis/genesis-remote/package',
    protocolBytes: captured.packageBytes,
  });
  const markerBytes = encodeSnapshotCommitMarkerV1({
    ...captured.commitMarker,
    packageLogicalKeyId: preparedPackage.logicalKeyId,
  });
  const preparedMarker = await input.codec.prepareOutbound({
    syncGenerationId: 'remote-generation',
    objectKind: 'snapshot-commit',
    canonicalLogicalKey: 'snapshot/remote-generation/genesis/genesis-remote/commit',
    protocolBytes: markerBytes,
  });
  for (const [objectKind, prepared] of [
    ['genesis', preparedPackage],
    ['snapshot-commit', preparedMarker],
  ] as const) {
    await input.provider.uploadImmutable({
      generation: input.providerGeneration,
      sourceRef: prepared.sourceRef,
      objectKind,
      logicalKeyId: prepared.logicalKeyId,
      storedSha256: prepared.storedSha256,
      sizeBytes: prepared.sizeBytes,
      transferId: `seed-${objectKind}`,
      signal: input.signal,
    });
  }
}

async function publishPostCheckpointTitle(input: {
  db: DbClient;
  provider: MemoryObjectLogProvider;
  codec: PlaintextSyncEngineObjectCodec;
  providerGeneration: ProviderGeneration;
  signal: AbortSignal;
}) {
  const changes = new SyncChangeBuilder();
  changes.add({
    action: 'field.set',
    target: { family: 'entity', kind: 'project', id: 'remote-project', incarnation: 0 },
    payload: { field: 'name', value: 'Post-checkpoint name' },
  });
  const recorded = await input.db.transaction((tx) =>
    recordAuthoredChangeSetInTransaction(
      tx,
      {
        projectId: 'remote-project',
        projectSyncId: 'remote-project-sync',
        syncGenerationId: 'remote-generation',
        identity: restoredWriterIdentity('remote-tail'),
        clock: { nowMs: 102, nowIso: NOW },
      },
      changes,
    ),
  );
  const segmentBytes = encodeSegmentV1({
    protocol: 'drifting.sync.segment',
    protocolVersion: 1,
    payloadVersion: 1,
    header: {
      codec: 'cbor-rfc8949',
      compression: 'none',
      projectId: 'remote-project',
      projectSyncId: 'remote-project-sync',
      syncGenerationId: 'remote-generation',
      writerId: recorded.changeSet.writerId,
      writerEpoch: recorded.changeSet.writerEpoch,
      firstSeq: 1,
      lastSeq: 1,
      opCount: 1,
      previousSegmentHash: null,
      requiredBlobIds: [],
    },
    changeSets: [recorded.changeSet],
  });
  const prepared = await input.codec.prepareOutbound({
    syncGenerationId: 'remote-generation',
    objectKind: 'segment',
    canonicalLogicalKey: 'segment/remote-generation/writer-remote-tail/epoch-remote-tail/1-1',
    protocolBytes: segmentBytes,
  });
  return input.provider.uploadImmutable({
    generation: input.providerGeneration,
    sourceRef: prepared.sourceRef,
    objectKind: 'segment',
    logicalKeyId: prepared.logicalKeyId,
    storedSha256: prepared.storedSha256,
    sizeBytes: prepared.sizeBytes,
    transferId: 'seed-post-checkpoint-segment',
    signal: input.signal,
  });
}

describe('Google Drive trusted-cloud connect orchestration', () => {
  it('fails closed when an inventoried immutable object is removed before cursor drain', async () => {
    const objects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(objects);
    const binding = {
      bindingId: 'restore-removal-race',
      syncGenerationId: 'remote-generation',
      accountRef: null,
      secretRef: null,
      authorityGeneration: 2,
    } as const;
    const generation = await provider.openGeneration(binding);
    const bytes = Uint8Array.of(1, 2, 3);
    const sourceRef = objects.put('restore.removal-race', bytes);
    await provider.uploadImmutable({
      generation,
      sourceRef,
      objectKind: 'genesis',
      logicalKeyId: 'restore-removal-logical-key',
      storedSha256: await sha256Bytes(bytes),
      sizeBytes: bytes.byteLength,
      transferId: 'restore-removal-upload',
      signal: new AbortController().signal,
    });
    let removed = false;
    const racingProvider: ObjectLogProvider = {
      kind: provider.kind,
      openGeneration: (input) => provider.openGeneration(input),
      captureStartCursor: (input) => provider.captureStartCursor(input),
      async listInventory(input) {
        const page = await provider.listInventory(input);
        if (!removed) {
          removed = true;
          expect(
            provider.removeRemoteObject(generation, 'restore-removal-logical-key'),
          ).not.toBeNull();
        }
        return page;
      },
      listChanges: (input) => provider.listChanges(input),
      statImmutable: (input) => provider.statImmutable(input),
      uploadImmutable: (input) => provider.uploadImmutable(input),
      downloadImmutable: (input) => provider.downloadImmutable(input),
    };

    await expect(
      discoverCurrentSyncGenerationObjects({
        provider: racingProvider,
        generation,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'blocked-corrupt' });
  });

  it('activates the drained cursor with its complete inventory, applies an observed tail, and blocks a pre-cycle removal', async () => {
    const source = await database('cursor-tail-source');
    await source.insert(ProjectTable).values({
      id: 'remote-project',
      userId: 'source-user',
      name: 'Remote project',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await source.insert(SyncGenerationTable).values({
      syncGenerationId: 'remote-generation',
      projectId: 'remote-project',
      projectSyncId: 'remote-project-sync',
      generationNumber: 1,
      protocolVersion: 1,
      domainSchemaVersion: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const objects = new MemoryProviderLocalObjectStore();
    let nextRef = 1;
    const codec = new PlaintextSyncEngineObjectCodec({
      allocate() {
        return objects.ref(`cursor-tail.${nextRef++}`);
      },
      read: (ref, signal) => objects.read(ref, signal),
      write: (ref, bytes, signal) => objects.write(ref, bytes, signal),
    });
    const provider = new MemoryObjectLogProvider(objects, { pageSize: 1 });
    const providerGeneration = await provider.openGeneration({
      bindingId: 'cursor-tail-seed',
      syncGenerationId: 'remote-generation',
      accountRef: null,
      secretRef: null,
      authorityGeneration: 2,
    });
    const signal = new AbortController().signal;
    await publishRemoteGenesis({ db: source, provider, codec, providerGeneration, signal });
    const tail = await publishPostCheckpointTitle({
      db: source,
      provider,
      codec,
      providerGeneration,
      signal,
    });

    const restoreTarget = async (label: string) => {
      const db = await database(label);
      const dependencies: GoogleDriveRestoreDependencies = {
        provider,
        discovery: discoveryFor(provider, providerGeneration),
        claimAccount: claimSameAccount,
        objectAccess: plaintextAccess(codec),
        async loadWriterIdentity() {
          return restoredWriterIdentity(label);
        },
        assetRestorePort: {
          async prepareVerifiedSource() {
            throw new Error('Snapshot has no assets');
          },
          async activatePreparedSources() {
            return 'empty-assets-activated';
          },
          async abandonAttempt() {},
        },
        async publishLocalSyncGeneration() {
          throw new Error('remote-only restore has no local SyncGeneration to publish');
        },
        nowIso: () => NOW,
        createAttemptId: () => `restore-${label}`,
      };
      await restoreGoogleDriveSyncGenerations({
        db,
        account: { accountSubject: 'google-subject', credentialSecretRef: 'secret:google' },
        localUserId: 'restored-user',
        signal,
        dependencies,
      });
      return db;
    };
    const normal = await restoreTarget('cursor-tail-normal');
    const removed = await restoreTarget('cursor-tail-removed');

    for (const db of [normal, removed]) {
      expect(await db.select().from(SyncCursorTable)).toMatchObject([
        {
          syncGenerationId: 'remote-generation',
          providerEpoch: 'memory:2:binding:2:remote-generation',
          inventoryComplete: true,
          pendingBaseCursor: null,
          pendingPageToken: null,
        },
      ]);
      expect(await db.select().from(SyncRemoteObjectTable)).toHaveLength(3);
      expect(await db.select().from(SyncRemoteObjectTable)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerObjectId: tail.object.objectId,
            objectKind: 'segment',
            removedAt: null,
          }),
        ]),
      );
    }

    const runtime = (db: DbClient, label: string) => new SqliteSyncGenerationRuntime({
      db,
      syncGenerationId: 'remote-generation',
      provider,
      providerBinding: {
        bindingId: 'binding:2:remote-generation',
        syncGenerationId: 'remote-generation',
        accountRef: 'google-subject',
        secretRef: 'secret:google',
        authorityGeneration: 2,
      },
      objectCodec: codec,
      writerIdentity: restoredWriterIdentity(label),
      domainKernel: productionSyncDomainMaterializationKernel,
      clock: {
        nowMs: () => Date.parse(NOW),
        nowIso: () => NOW,
      },
    });
    await expect(runtime(normal, 'normal-runtime').runCycle(new Set(['start']), signal))
      .resolves.toMatchObject({ converged: true });
    expect(
      await normal
        .select({ name: ProjectTable.name })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, 'remote-project')),
    ).toEqual([{ name: 'Post-checkpoint name' }]);
    expect(await normal.select().from(SyncApplyReceiptTable)).toHaveLength(1);

    expect(provider.removeRemoteObject(providerGeneration, tail.object.logicalKeyId)).not.toBeNull();
    await expect(runtime(removed, 'removed-runtime').runCycle(new Set(['start']), signal))
      .rejects.toThrow('provider removed a previously observed immutable object');
    expect(await removed.select().from(SyncProviderBindingTable)).toMatchObject([
      { syncGenerationId: 'remote-generation', state: 'blocked-corrupt' },
    ]);
    expect(await removed.select().from(SyncRemoteObjectTable)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerObjectId: tail.object.objectId,
          objectKind: 'segment',
          removedAt: NOW,
        }),
      ]),
    );
    expect(await removed.select().from(SyncApplyReceiptTable)).toEqual([]);
  });

  it('restores a committed remote SyncGeneration and activates project + App authority atomically', async () => {
    const source = await database('source');
    await source.insert(ProjectTable).values({
      id: 'remote-project',
      userId: 'source-user',
      name: 'Same visible name is not identity',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await source.insert(SyncGenerationTable).values({
      syncGenerationId: 'remote-generation',
      projectId: 'remote-project',
      projectSyncId: 'remote-project-sync',
      generationNumber: 1,
      protocolVersion: 1,
      domainSchemaVersion: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const objects = new MemoryProviderLocalObjectStore();
    let nextRef = 1;
    const codec = new PlaintextSyncEngineObjectCodec({
      allocate() {
        return objects.ref(`restore.${nextRef++}`);
      },
      read: (ref, signal) => objects.read(ref, signal),
      write: (ref, bytes, signal) => objects.write(ref, bytes, signal),
    });
    const provider = new MemoryObjectLogProvider(objects, { pageSize: 1 });
    const providerGeneration = await provider.openGeneration({
      bindingId: 'seed-binding',
      syncGenerationId: 'remote-generation',
      accountRef: null,
      secretRef: null,
      authorityGeneration: 2,
    });
    const signal = new AbortController().signal;
    await publishRemoteGenesis({ db: source, provider, codec, providerGeneration, signal });

    const target = await database('target');
    await target.insert(ProjectTable).values({
      id: 'local-project',
      userId: 'local-device-user',
      name: 'Same visible name is not identity',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await target.insert(SyncGenerationTable).values({
      syncGenerationId: 'local-generation',
      projectId: 'local-project',
      projectSyncId: 'local-project-sync',
      generationNumber: 1,
      protocolVersion: 1,
      domainSchemaVersion: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    let authorityChangedEvents = 0;
    const changedProjectIds: string[] = [];
    const dependencies: GoogleDriveRestoreDependencies = {
      provider,
      discovery: discoveryFor(provider, providerGeneration),
      claimAccount: claimSameAccount,
      objectAccess: plaintextAccess(codec),
      async loadWriterIdentity() {
        return restoredWriterIdentity('drive-restore');
      },
      assetRestorePort: {
        async prepareVerifiedSource() {
          throw new Error('Snapshot has no assets');
        },
        async activatePreparedSources() {
          return 'empty-assets-activated';
        },
        async abandonAttempt() {},
      },
      async publishLocalSyncGeneration({ db, syncGenerationId }) {
        await db.insert(SyncRemoteObjectTable).values({
          id: `local-genesis-marker:${syncGenerationId}`,
          syncGenerationId,
          providerObjectId: `provider-local-marker:${syncGenerationId}`,
          logicalKeyId: `logical-local-marker:${syncGenerationId}`,
          objectKind: 'snapshot-commit',
          storedSha256: '0'.repeat(64),
          sizeBytes: 1,
          firstObservedAt: NOW,
          lastObservedAt: NOW,
        });
        return { commitMarkerRemoteObjectId: `local-genesis-marker:${syncGenerationId}` };
      },
      nowIso: () => NOW,
      createAttemptId: () => 'restore-drive-attempt',
      emitAuthorityChanged() {
        authorityChangedEvents += 1;
      },
      emitProjectChanged(projectId) {
        changedProjectIds.push(projectId);
      },
    };
    const result = await restoreGoogleDriveSyncGenerations({
      db: target,
      account: { accountSubject: 'google-subject', credentialSecretRef: 'secret:google' },
      localUserId: 'local-device-user',
      signal,
      dependencies,
    });

    expect(result.restored).toEqual([
      {
        syncGenerationId: 'remote-generation',
        projectId: 'remote-project',
        projectSyncId: 'remote-project-sync',
        snapshotId: 'genesis-remote',
      },
    ]);
    expect(result.connectedLocalSyncGenerationIds).toEqual(['local-generation']);
    expect(authorityChangedEvents).toBe(1);
    expect(changedProjectIds).toEqual(['remote-project']);
    expect(
      (await target.select().from(ProjectTable)).sort((left, right) =>
        compareUtf8Bytewise(left.id, right.id),
      ),
    ).toMatchObject([
      { id: 'local-project', name: 'Same visible name is not identity', userId: 'local-device-user' },
      { id: 'remote-project', name: 'Same visible name is not identity', userId: 'local-device-user' },
    ]);
    expect(await target.select().from(SyncAppAuthorityTable)).toMatchObject([
      { mode: 'google-drive', generation: 2, transitionState: 'stable' },
    ]);
    expect(
      (await target.select().from(SyncProviderBindingTable)).map(({ syncGenerationId }) => syncGenerationId).sort(),
    ).toEqual(['local-generation', 'remote-generation']);
    expect(await target.select().from(SyncRestoreAttemptTable)).toMatchObject([
      {
        sourceSyncGenerationId: 'remote-generation',
        sourceCheckpointId: 'genesis-remote',
        state: 'completed',
        targetProjectId: 'remote-project',
      },
    ]);
    expect(await target.select().from(SyncCheckpointTable)).toMatchObject([
      {
        checkpointId: 'genesis-remote',
        syncGenerationId: 'remote-generation',
        state: 'published',
        changeSetCount: 0,
      },
    ]);
    expect(await target.select().from(SyncLocalObjectTable)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          syncGenerationId: 'remote-generation',
          objectKind: 'genesis',
          state: 'published',
        }),
      ]),
    );
    expect(await target.select().from(SyncConnectGenerationAttemptTable)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceSyncGenerationId: 'remote-generation',
          sourceCheckpointId: 'genesis-remote',
          state: 'activated',
        }),
      ]),
    );
    expect(await target.select().from(SyncConnectAttemptTable)).toMatchObject([
      { attemptId: 'restore-drive-attempt', kind: 'connect', state: 'completed' },
    ]);
  });
});
