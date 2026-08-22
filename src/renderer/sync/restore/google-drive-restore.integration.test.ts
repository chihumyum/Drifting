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
import { createSyncAppAuthorityRepository } from '../app-authority-repository';
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
  return discoveryForMany(provider, [generation]);
}

function discoveryForMany(
  provider: MemoryObjectLogProvider,
  generations: readonly ProviderGeneration[],
): GoogleDriveRestoreDependencies['discovery'] {
  return {
    async discover() {
      const discovered = await Promise.all(
        generations.map(async (generation) => {
          const inventory = await provider.listInventory({ generation });
          return inventory.objects
            .filter(
              (object): object is RemoteObject & { readonly objectKind: 'snapshot-commit' } =>
                object.objectKind === 'snapshot-commit',
            )
            .map((object) => ({ syncGenerationId: generation.syncGenerationId, object }));
        }),
      );
      return discovered.flat();
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
  projectId?: string;
  syncGenerationId?: string;
  snapshotId?: string;
}) {
  const projectId = input.projectId ?? 'remote-project';
  const syncGenerationId = input.syncGenerationId ?? 'remote-generation';
  const snapshotId = input.snapshotId ?? 'genesis-remote';
  const captured = await captureSnapshotV1({
    db: input.db,
    projectId,
    syncGenerationId,
    snapshotId,
    snapshotKind: 'genesis',
    packageLogicalKeyId: 'pending-package-key',
    capturedAt: { wallMs: 100, counter: 0 },
    committedAt: { wallMs: 101, counter: 0 },
  });
  const preparedPackage = await input.codec.prepareOutbound({
    syncGenerationId,
    objectKind: 'genesis',
    canonicalLogicalKey: `snapshot/${syncGenerationId}/genesis/${snapshotId}/package`,
    protocolBytes: captured.packageBytes,
  });
  const markerBytes = encodeSnapshotCommitMarkerV1({
    ...captured.commitMarker,
    packageLogicalKeyId: preparedPackage.logicalKeyId,
  });
  const preparedMarker = await input.codec.prepareOutbound({
    syncGenerationId,
    objectKind: 'snapshot-commit',
    canonicalLogicalKey: `snapshot/${syncGenerationId}/genesis/${snapshotId}/commit`,
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
      transferId: `seed-${syncGenerationId}-${objectKind}`,
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

  it.each([
    { recoveryLabel: 'resuming the same durable attempt', cancelFirst: false },
    { recoveryLabel: 'cancelling and starting a fresh connect', cancelFirst: true },
  ])(
    'restores a resolved staged remote SyncGeneration after $recoveryLabel',
    async ({ cancelFirst }) => {
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
    let writerIdentityLoads = 0;
    let nextAttemptId = 'restore-drive-attempt';
    const dependencies: GoogleDriveRestoreDependencies = {
      provider,
      discovery: discoveryFor(provider, providerGeneration),
      claimAccount: claimSameAccount,
      objectAccess: plaintextAccess(codec),
      async loadWriterIdentity() {
        writerIdentityLoads += 1;
        if (writerIdentityLoads === 1) {
          throw new Error('injected failure after remote identity resolution');
        }
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
        await db
          .insert(SyncRemoteObjectTable)
          .values({
            id: `local-genesis-marker:${syncGenerationId}`,
            syncGenerationId,
            providerObjectId: `provider-local-marker:${syncGenerationId}`,
            logicalKeyId: `logical-local-marker:${syncGenerationId}`,
            objectKind: 'snapshot-commit',
            storedSha256: '0'.repeat(64),
            sizeBytes: 1,
            firstObservedAt: NOW,
            lastObservedAt: NOW,
          })
          .onConflictDoNothing();
        return { commitMarkerRemoteObjectId: `local-genesis-marker:${syncGenerationId}` };
      },
      nowIso: () => NOW,
      createAttemptId: () => nextAttemptId,
      emitAuthorityChanged() {
        authorityChangedEvents += 1;
      },
      emitProjectChanged(projectId) {
        changedProjectIds.push(projectId);
      },
    };
    await expect(
      restoreGoogleDriveSyncGenerations({
        db: target,
        account: { accountSubject: 'google-subject', credentialSecretRef: 'secret:google' },
        localUserId: 'local-device-user',
        signal,
        dependencies,
      }),
    ).rejects.toMatchObject({ code: 'restore-failed' });
    expect(authorityChangedEvents).toBe(1);
    expect(await target.select().from(SyncGenerationTable).where(eq(SyncGenerationTable.syncGenerationId, 'remote-generation')))
      .toMatchObject([
        {
          projectId: null,
          projectSyncId: 'remote-project-sync',
          status: 'staged',
        },
      ]);

    let retryAttemptId = 'restore-drive-attempt';
    if (cancelFirst) {
      await createSyncAppAuthorityRepository(target).cancel({
        attemptId: 'restore-drive-attempt',
        nowIso: NOW,
      });
      expect(await target.select().from(SyncGenerationTable).where(eq(SyncGenerationTable.syncGenerationId, 'remote-generation')))
        .toMatchObject([{ projectId: null, status: 'retired' }]);
      nextAttemptId = 'restore-drive-attempt-after-cancel';
      retryAttemptId = nextAttemptId;
    }
    const result = await restoreGoogleDriveSyncGenerations({
      db: target,
      account: { accountSubject: 'google-subject', credentialSecretRef: 'secret:google' },
      localUserId: 'local-device-user',
      signal,
      ...(cancelFirst ? {} : { attemptId: 'restore-drive-attempt' }),
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
    expect(authorityChangedEvents).toBe(2);
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
    expect(await target.select().from(SyncConnectAttemptTable)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attemptId: retryAttemptId, kind: 'connect', state: 'completed' }),
      ]),
    );
    },
  );

  it.each([
    { caseLabel: 'offline local edits', detachedPurge: false },
    { caseLabel: 'an offline project purge', detachedPurge: true },
  ])('rebinds an exact generation after disconnect with $caseLabel', async ({ detachedPurge }) => {
    const source = await database(`reconnect-source-${detachedPurge ? 'purge' : 'edit'}`);
    await source.insert(ProjectTable).values({
      id: 'remote-project',
      userId: 'source-user',
      name: 'Remote before disconnect',
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
        return objects.ref(`reconnect.${nextRef++}`);
      },
      read: (ref, signal) => objects.read(ref, signal),
      write: (ref, bytes, signal) => objects.write(ref, bytes, signal),
    });
    const provider = new MemoryObjectLogProvider(objects, { pageSize: 1 });
    const providerGeneration = await provider.openGeneration({
      bindingId: 'reconnect-seed',
      syncGenerationId: 'remote-generation',
      accountRef: null,
      secretRef: null,
      authorityGeneration: 2,
    });
    const historicalProviderGeneration = await provider.openGeneration({
      bindingId: 'historical-reconnect-seed',
      syncGenerationId: 'historical-purged-generation',
      accountRef: null,
      secretRef: null,
      authorityGeneration: 2,
    });
    const signal = new AbortController().signal;
    await publishRemoteGenesis({ db: source, provider, codec, providerGeneration, signal });

    // Build the historical generation in an isolated source database. Snapshot
    // capture deliberately requires exactly one active generation per project
    // authority, which also mirrors the separate project that originally
    // published these immutable Drive objects.
    const historicalSource = await database(
      `reconnect-historical-source-${detachedPurge ? 'purge' : 'edit'}`,
    );
    await historicalSource.insert(ProjectTable).values({
      id: 'historical-remote-project',
      userId: 'source-user',
      name: 'Historical project already purged locally',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await historicalSource.insert(SyncGenerationTable).values({
      syncGenerationId: 'historical-purged-generation',
      projectId: 'historical-remote-project',
      projectSyncId: 'historical-project-sync',
      generationNumber: 1,
      protocolVersion: 1,
      domainSchemaVersion: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await publishRemoteGenesis({
      db: historicalSource,
      provider,
      codec,
      providerGeneration: historicalProviderGeneration,
      signal,
      projectId: 'historical-remote-project',
      syncGenerationId: 'historical-purged-generation',
      snapshotId: 'genesis-historical-purged',
    });
    const previouslyPublishedInventory = await discoverCurrentSyncGenerationObjects({
      provider,
      generation: providerGeneration,
      signal,
    });
    const previouslyPublishedMarker = previouslyPublishedInventory.objects.find(
      (object) => object.objectKind === 'snapshot-commit',
    );
    if (!previouslyPublishedMarker) throw new Error('Reconnect fixture is missing its marker');

    const target = await database(`reconnect-target-${detachedPurge ? 'purge' : 'edit'}`);
    await target.insert(ProjectTable).values({
      id: 'remote-project',
      userId: 'local-device-user',
      name: 'Edited while Drive was disconnected',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await target.insert(SyncGenerationTable).values({
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
    // Immutable Drive inventory still discovers this old generation after
    // local purge. Reconnect must treat its terminal local receipt as handled
    // history and continue to the active generation below.
    await target.insert(SyncGenerationTable).values({
      syncGenerationId: 'historical-purged-generation',
      projectId: null,
      projectSyncId: 'historical-project-sync',
      generationNumber: 1,
      protocolVersion: 1,
      domainSchemaVersion: 1,
      status: 'purged',
      createdAt: NOW,
      updatedAt: NOW,
      purgedAt: NOW,
    });
    // Existing connected databases used provider-object row IDs for genesis
    // and marker inventory. Reconnect must reference the durable row that is
    // already present instead of assuming the newer canonical remote row ID.
    for (const object of previouslyPublishedInventory.objects) {
      await target.insert(SyncRemoteObjectTable).values({
        id: JSON.stringify(['provider-object', 'remote-generation', object.objectId]),
        syncGenerationId: 'remote-generation',
        providerObjectId: object.objectId,
        logicalKeyId: object.logicalKeyId,
        objectKind: object.objectKind,
        storedSha256: object.storedSha256.slice('sha256:'.length),
        sizeBytes: object.sizeBytes,
        firstObservedAt: NOW,
        lastObservedAt: NOW,
      });
    }
    // A project originally restored on this device must be reconnectable too;
    // historical restore receipts are not evidence of a duplicate authority.
    await target.insert(SyncRestoreAttemptTable).values({
      attemptId: 'historical-restore',
      sourceSyncGenerationId: 'remote-generation',
      sourceCheckpointId: null,
      targetProjectId: 'remote-project',
      stagingRef: 'opaque:historical-restore',
      state: 'completed',
      validationCode: 'valid',
      activationReceipt: 'historical-activation',
      errorCode: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    });
    const localChanges = new SyncChangeBuilder();
    if (detachedPurge) {
      localChanges.add({
        action: 'sync-generation.purge',
        target: {
          family: 'sync-generation',
          kind: 'sync-generation',
          id: 'remote-generation',
          incarnation: 1,
        },
        payload: {},
      });
    } else {
      localChanges.add({
        action: 'field.set',
        target: { family: 'entity', kind: 'project', id: 'remote-project', incarnation: 0 },
        payload: { field: 'name', value: 'Edited while Drive was disconnected' },
      });
    }
    const reconnectWriter = restoredWriterIdentity('reconnect-target');
    await target.transaction(async (tx) => {
      if (detachedPurge) {
        await tx.delete(ProjectTable).where(eq(ProjectTable.id, 'remote-project'));
      }
      await recordAuthoredChangeSetInTransaction(
        tx,
        {
          projectId: 'remote-project',
          projectSyncId: 'remote-project-sync',
          syncGenerationId: 'remote-generation',
          identity: reconnectWriter,
          clock: { nowMs: 103, nowIso: NOW },
          ...(detachedPurge ? { allowDetachedProject: true } : {}),
        },
        localChanges,
      );
    });

    const dependencies: GoogleDriveRestoreDependencies = {
      provider,
      discovery: discoveryForMany(provider, [
        historicalProviderGeneration,
        providerGeneration,
      ]),
      claimAccount: claimSameAccount,
      objectAccess: plaintextAccess(codec),
      async loadWriterIdentity() {
        throw new Error('exact-generation reconnect must not initialize restored project state');
      },
      assetRestorePort: {
        async prepareVerifiedSource() {
          throw new Error('exact-generation reconnect must not restore snapshot assets');
        },
        async activatePreparedSources() {
          throw new Error('exact-generation reconnect must not activate restored assets');
        },
        async abandonAttempt() {},
      },
      async publishLocalSyncGeneration() {
        throw new Error('exact-generation reconnect must not republish genesis');
      },
      nowIso: () => NOW,
      createAttemptId: () => 'reconnect-drive-attempt',
    };
    const result = await restoreGoogleDriveSyncGenerations({
      db: target,
      account: { accountSubject: 'google-subject', credentialSecretRef: 'secret:google' },
      localUserId: 'local-device-user',
      signal,
      dependencies,
    });

    expect(result.restored).toEqual([]);
    expect(result.connectedLocalSyncGenerationIds).toEqual(['remote-generation']);
    expect(
      await target
        .select()
        .from(SyncGenerationTable)
        .where(eq(SyncGenerationTable.syncGenerationId, 'historical-purged-generation')),
    ).toMatchObject([
      {
        syncGenerationId: 'historical-purged-generation',
        projectId: null,
        status: 'purged',
      },
    ]);
    expect(await target.select().from(ProjectTable)).toMatchObject(
      detachedPurge
        ? []
        : [{ id: 'remote-project', name: 'Edited while Drive was disconnected' }],
    );
    expect(await target.select().from(SyncRestoreAttemptTable)).toHaveLength(1);
    expect(await target.select().from(SyncProviderBindingTable)).toMatchObject([
      { syncGenerationId: 'remote-generation', state: 'ready' },
    ]);
    expect(await target.select().from(SyncConnectGenerationAttemptTable)).toMatchObject([
      {
        sourceSyncGenerationId: 'remote-generation',
        commitMarkerObjectId: JSON.stringify([
          'provider-object',
          'remote-generation',
          previouslyPublishedMarker.objectId,
        ]),
        state: 'activated',
      },
    ]);
    expect(await target.select().from(SyncCursorTable)).toMatchObject([
      { syncGenerationId: 'remote-generation', inventoryComplete: true },
    ]);

    const runtime = new SqliteSyncGenerationRuntime({
      db: target,
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
      writerIdentity: reconnectWriter,
      domainKernel: productionSyncDomainMaterializationKernel,
      clock: {
        nowMs: () => Date.parse(NOW),
        nowIso: () => NOW,
      },
    });
    await expect(runtime.runCycle(new Set(['manual']), signal)).resolves.toMatchObject(
      detachedPurge ? { publishedSegments: 1 } : { converged: true },
    );
    const inventory = await discoverCurrentSyncGenerationObjects({
      provider,
      generation: providerGeneration,
      signal,
    });
    expect(inventory.objects.some((object) => object.objectKind === 'segment')).toBe(true);
    expect(await target.select().from(ProjectTable)).toMatchObject(
      detachedPurge
        ? []
        : [{ id: 'remote-project', name: 'Edited while Drive was disconnected' }],
    );
    if (detachedPurge) {
      expect(await target.select().from(SyncGenerationTable)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            syncGenerationId: 'remote-generation',
            projectId: null,
            status: 'purged',
          }),
          expect.objectContaining({
            syncGenerationId: 'historical-purged-generation',
            projectId: null,
            status: 'purged',
          }),
        ]),
      );
    }
  });
});
