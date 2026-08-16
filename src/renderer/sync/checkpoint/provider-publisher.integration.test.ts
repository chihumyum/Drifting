import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  ProjectAssetTable,
  ProjectTable,
  SyncBlobStateTable,
  SyncChangeSetTable,
  SyncCheckpointTable,
  SyncConflictTable,
  SyncFrontierGapTable,
  SyncLocalObjectTable,
  SyncQuarantinedObjectTable,
  SyncRemoteObjectTable,
  SyncTransferTable,
  SyncGenerationTable,
} from '../../schema/drizzle';
import type { SyncEngineBlobPort } from '../engine';
import { PlaintextSyncEngineObjectCodec } from '../engine/plaintext-object-codec';
import {
  decodeSnapshotCommitMarkerV1,
  sha256Bytes,
  type LocalObjectRef,
} from '../protocol';
import { MemoryProviderLocalObjectStore } from '../providers/local-object-store';
import { MemoryObjectLogProvider } from '../providers/memory-provider';
import {
  createProviderCheckpointHook,
  ProviderSnapshotPublisher,
} from './provider-publisher';

const NOW = '2026-08-15T12:00:00.000Z';
const PROJECT_ID = 'project-provider-publisher';
const SYNC_GENERATION_ID = 'sync-generation-provider-publisher';
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-provider-snapshot-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT_ID,
    name: 'Provider snapshot',
    userId: 'local-user',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(SyncGenerationTable).values({
    syncGenerationId: SYNC_GENERATION_ID,
    projectId: PROJECT_ID,
    projectSyncId: 'project-sync-provider-publisher',
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
    allocate: () => objects.ref(`snapshot.${nextRef++}`),
    read: (ref, signal) => objects.read(ref, signal),
    write: (ref, bytes, signal) => objects.write(ref, bytes, signal),
  });
  const provider = new MemoryObjectLogProvider(objects);
  const providerGeneration = await provider.openGeneration({
    bindingId: 'binding-provider-publisher',
    syncGenerationId: SYNC_GENERATION_ID,
    accountRef: null,
    secretRef: null,
    authorityGeneration: 1,
  });
  const blobPort: SyncEngineBlobPort = {
    async prepareOutbound() {
      throw new Error('No asset is expected in this fixture');
    },
    async verifyAndInstallInbound() {
      throw new Error('Inbound blobs are outside this test');
    },
  };
  const publisher = new ProviderSnapshotPublisher({
    db,
    projectId: PROJECT_ID,
    syncGenerationId: SYNC_GENERATION_ID,
    provider,
    providerGeneration,
    objectCodec: codec,
    blobPort,
    assetCapturePort: {
      async captureCanonicalSource() {
        throw new Error('No asset is expected in this fixture');
      },
    },
    nowMs: () => Date.parse(NOW),
    nowIso: () => NOW,
  });
  return { db, gateway, objects, provider, providerGeneration, codec, publisher };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('durable provider snapshot publisher', () => {
  it('rebuilds the marker with the actual package identity and publishes marker last', async () => {
    const fixture = await setup();
    const upload = vi.spyOn(fixture.provider, 'uploadImmutable');
    const published = await fixture.publisher.publishSnapshot({
      snapshotId: 'genesis-provider-publisher',
      snapshotKind: 'genesis',
      signal: new AbortController().signal,
    });

    const inventory = await fixture.provider.listInventory({ generation: fixture.providerGeneration });
    expect(inventory.objects.map(({ objectKind }) => objectKind).sort()).toEqual([
      'genesis', 'snapshot-commit',
    ]);
    expect(upload.mock.calls.map(([input]) => input.objectKind)).toEqual([
      'genesis', 'snapshot-commit',
    ]);
    expect(published.commitMarkerRemoteObjectId).toContain('memory-object:2');
    const locals = await fixture.db
      .select()
      .from(SyncLocalObjectTable)
      .where(eq(SyncLocalObjectTable.syncGenerationId, SYNC_GENERATION_ID));
    const packageObject = locals.find(({ objectKind }) => objectKind === 'genesis')!;
    const markerObject = locals.find(({ objectKind }) => objectKind === 'snapshot-commit')!;
    const markerBytes = await fixture.objects.read(
      markerObject.storageRef as LocalObjectRef,
      new AbortController().signal,
    );
    const marker = decodeSnapshotCommitMarkerV1(markerBytes);
    expect(marker.ok).toBe(true);
    if (!marker.ok) throw new Error(marker.reason);
    expect(marker.value.packageLogicalKeyId).toBe(packageObject.logicalKeyId);
    expect(await fixture.db.select().from(SyncCheckpointTable)).toMatchObject([
      { checkpointId: 'genesis-provider-publisher', state: 'published' },
    ]);
    expect(await fixture.db.select().from(SyncTransferTable)).toHaveLength(2);
    expect(
      (await fixture.db.select().from(SyncTransferTable)).every(({ state }) => state === 'completed'),
    ).toBe(true);
    expect(fixture.gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('reconciles a lost upload response without creating another remote marker', async () => {
    const fixture = await setup();
    const upload = fixture.provider.uploadImmutable.bind(fixture.provider);
    let loseMarkerResponse = true;
    vi.spyOn(fixture.provider, 'uploadImmutable').mockImplementation(async (input) => {
      const result = await upload(input);
      if (input.objectKind === 'snapshot-commit' && loseMarkerResponse) {
        loseMarkerResponse = false;
        throw new Error('injected response loss');
      }
      return result;
    });

    await expect(
      fixture.publisher.publishSnapshot({
        snapshotId: 'genesis-response-loss',
        snapshotKind: 'genesis',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('injected response loss');
    expect(
      (await fixture.db.select().from(SyncTransferTable)).some(
        ({ state }) => state === 'retry-wait',
      ),
    ).toBe(true);

    await fixture.publisher.publishSnapshot({
      snapshotId: 'genesis-response-loss',
      snapshotKind: 'genesis',
      signal: new AbortController().signal,
    });
    const inventory = await fixture.provider.listInventory({ generation: fixture.providerGeneration });
    expect(inventory.objects).toHaveLength(2);
    expect(await fixture.db.select().from(SyncRemoteObjectTable)).toHaveLength(2);
    expect(
      (await fixture.db.select().from(SyncTransferTable)).every(({ state }) => state === 'completed'),
    ).toBe(true);
  });

  it('reuses a restored verified asset and its known remote object for the next checkpoint', async () => {
    const fixture = await setup();
    const restoredBytes = Uint8Array.of(8, 9, 10, 11);
    const sourceSha256 = await sha256Bytes(restoredBytes);
    const blobId = sourceSha256;
    const logicalKeyId = await sha256Bytes(
      new TextEncoder().encode(`blob\0${SYNC_GENERATION_ID}\0${blobId}`),
    );
    const restoredRef = fixture.objects.ref('restored.asset.object');
    await fixture.objects.write(
      restoredRef,
      restoredBytes,
      new AbortController().signal,
    );
    const remote = (
      await fixture.provider.uploadImmutable({
        generation: fixture.providerGeneration,
        sourceRef: restoredRef,
        objectKind: 'blob',
        logicalKeyId,
        storedSha256: sourceSha256,
        sizeBytes: restoredBytes.byteLength,
        transferId: 'seed-restored-asset-object',
        signal: new AbortController().signal,
      })
    ).object;
    await fixture.db.insert(ProjectAssetTable).values({
      id: 'restored-asset',
      projectId: PROJECT_ID,
      kind: 'image',
      sourceMime: 'image/png',
      sourceSizeBytes: restoredBytes.byteLength,
      sourceSha256: sourceSha256.slice('sha256:'.length),
      width: 10,
      height: 20,
      createdAt: NOW,
    });
    await fixture.db.insert(SyncRemoteObjectTable).values({
      id: 'remote-restored-asset',
      syncGenerationId: SYNC_GENERATION_ID,
      providerObjectId: remote.objectId,
      logicalKeyId,
      objectKind: 'blob',
      storedSha256: remote.storedSha256.slice('sha256:'.length),
      sizeBytes: remote.sizeBytes,
      firstObservedAt: NOW,
      lastObservedAt: NOW,
    });
    await fixture.db.insert(SyncBlobStateTable).values({
      syncGenerationId: SYNC_GENERATION_ID,
      blobId,
      assetId: 'restored-asset',
      logicalKeyId,
      contentSha256: sourceSha256.slice('sha256:'.length),
      sizeBytes: restoredBytes.byteLength,
      mime: 'image/png',
      localObjectId: null,
      localState: 'verified',
      remoteState: 'available',
      verifiedAt: NOW,
      updatedAt: NOW,
    });
    const prepareOutbound = vi.fn(async () => {
      throw new Error('restored remote object must be reused');
    });
    const publisher = new ProviderSnapshotPublisher({
      db: fixture.db,
      projectId: PROJECT_ID,
      syncGenerationId: SYNC_GENERATION_ID,
      provider: fixture.provider,
      providerGeneration: fixture.providerGeneration,
      objectCodec: fixture.codec,
      blobPort: {
        prepareOutbound,
        async verifyAndInstallInbound() {
          throw new Error('Inbound blobs are outside this test');
        },
      },
      assetCapturePort: {
        async captureCanonicalSource() {
          return {
            blobId,
            sourceRef: fixture.objects.ref('restored.asset.source'),
            sourceSha256,
            sizeBytes: restoredBytes.byteLength,
            mimeType: 'image/png',
          };
        },
      },
      nowMs: () => Date.parse(NOW),
      nowIso: () => NOW,
    });

    await expect(
      publisher.publishSnapshot({
        snapshotId: 'checkpoint-after-asset-restore',
        snapshotKind: 'checkpoint',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ snapshotKind: 'checkpoint' });
    expect(prepareOutbound).not.toHaveBeenCalled();
    expect((await fixture.provider.listInventory({ generation: fixture.providerGeneration })).objects)
      .toHaveLength(3);
    expect(await fixture.db.select().from(SyncBlobStateTable)).toMatchObject([
      {
        blobId,
        localObjectId: null,
        localState: 'verified',
        remoteState: 'available',
      },
    ]);
  });

  it('rejects conflicting metadata returned by a provider upload', async () => {
    const fixture = await setup();
    const upload = fixture.provider.uploadImmutable.bind(fixture.provider);
    vi.spyOn(fixture.provider, 'uploadImmutable').mockImplementation(async (input) => {
      const result = await upload(input);
      if (input.objectKind !== 'genesis') return result;
      return {
        ...result,
        object: {
          ...result.object,
          storedSha256: `sha256:${'f'.repeat(64)}` as typeof result.object.storedSha256,
        },
      };
    });

    await expect(
      fixture.publisher.publishSnapshot({
        snapshotId: 'genesis-conflicting-provider-result',
        snapshotKind: 'genesis',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('conflicting immutable bytes');
    expect(await fixture.db.select().from(SyncRemoteObjectTable)).toEqual([]);
    expect(await fixture.db.select().from(SyncTransferTable)).toMatchObject([
      { objectKind: 'genesis', state: 'retry-wait' },
    ]);
  });

  it('does not checkpoint a purged or detached SyncGeneration', async () => {
    const fixture = await setup();
    await fixture.db
      .update(SyncGenerationTable)
      .set({ projectId: null, status: 'purged', purgedAt: NOW, updatedAt: NOW })
      .where(eq(SyncGenerationTable.syncGenerationId, SYNC_GENERATION_ID));
    const publish = vi.spyOn(fixture.publisher, 'publishSnapshot');
    const hook = createProviderCheckpointHook({
      db: fixture.db,
      syncGenerationId: SYNC_GENERATION_ID,
      publisher: fixture.publisher,
    });
    await expect(
      hook.captureIfDue({ syncGenerationId: SYNC_GENERATION_ID, signal: new AbortController().signal }),
    ).resolves.toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('blocks periodic checkpoints while any gap, semantic conflict or quarantine is open', async () => {
    const fixture = await setup();
    await fixture.db.insert(SyncChangeSetTable).values({
      changeSetId: 'writer:epoch:1',
      syncGenerationId: SYNC_GENERATION_ID,
      projectId: PROJECT_ID,
      projectSyncId: 'project-sync-provider-publisher',
      writerId: 'writer',
      writerEpoch: 'epoch',
      deviceSeq: 1,
      hlcWallMs: 1,
      hlcCounter: 0,
      mutationCount: 1,
      encodedBytes: new Uint8Array([1]),
      payloadSha256: '0'.repeat(64),
      origin: 'local',
      applyState: 'applied',
      createdAt: NOW,
      appliedAt: NOW,
    });
    const publish = vi.spyOn(fixture.publisher, 'publishSnapshot');
    const hook = createProviderCheckpointHook({
      db: fixture.db,
      syncGenerationId: SYNC_GENERATION_ID,
      publisher: fixture.publisher,
      changeSetThreshold: 1,
    });

    await fixture.db.insert(SyncFrontierGapTable).values({
      id: 'gap-open',
      syncGenerationId: SYNC_GENERATION_ID,
      writerId: 'writer',
      writerEpoch: 'epoch',
      lane: 'applied',
      firstSeq: 1,
      lastSeq: 1,
      state: 'open',
      observedAt: NOW,
    });
    await expect(
      hook.captureIfDue({ syncGenerationId: SYNC_GENERATION_ID, signal: new AbortController().signal }),
    ).resolves.toBe(false);
    await fixture.db.delete(SyncFrontierGapTable).where(eq(SyncFrontierGapTable.id, 'gap-open'));

    await fixture.db.insert(SyncConflictTable).values({
      conflictId: 'conflict-open',
      syncGenerationId: SYNC_GENERATION_ID,
      kind: 'semantic',
      detailsCbor: new Uint8Array([0xa0]),
      state: 'open',
      createdAt: NOW,
    });
    await expect(
      hook.captureIfDue({ syncGenerationId: SYNC_GENERATION_ID, signal: new AbortController().signal }),
    ).resolves.toBe(false);
    await fixture.db.delete(SyncConflictTable).where(eq(SyncConflictTable.conflictId, 'conflict-open'));

    await fixture.db.insert(SyncLocalObjectTable).values({
      id: 'quarantine-local',
      syncGenerationId: SYNC_GENERATION_ID,
      objectKind: 'quarantine',
      logicalKeyId: 'quarantine-logical',
      storageRef: 'syncobj:test.quarantine',
      storedSha256: '0'.repeat(64),
      sizeBytes: 1,
      codec: 'opaque',
      state: 'quarantined',
      createdAt: NOW,
    });
    await fixture.db.insert(SyncQuarantinedObjectTable).values({
      quarantineId: 'quarantine-open',
      syncGenerationId: SYNC_GENERATION_ID,
      localObjectId: 'quarantine-local',
      reason: 'test',
      storedSha256: '0'.repeat(64),
      sizeBytes: 1,
      state: 'blocked-corrupt',
      createdAt: NOW,
    });
    await expect(
      hook.captureIfDue({ syncGenerationId: SYNC_GENERATION_ID, signal: new AbortController().signal }),
    ).resolves.toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });
});
