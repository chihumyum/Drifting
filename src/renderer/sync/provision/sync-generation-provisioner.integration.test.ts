import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  ProjectTable,
  SyncChangeSetTable,
  SyncCheckpointTable,
  SyncProviderBindingTable,
  SyncTransferTable,
  SyncGenerationTable,
} from '../../schema/drizzle';
import { createSyncAppAuthorityRepository } from '../app-authority-repository';
import { ProviderSnapshotPublisher } from '../checkpoint';
import type { SyncEngineBlobPort } from '../engine';
import { PlaintextSyncEngineObjectCodec } from '../engine/plaintext-object-codec';
import {
  appendAuthoredDomainMutation,
  createAuthoredTransactionRunner,
} from '../journal';
import { MemoryProviderLocalObjectStore } from '../providers/local-object-store';
import { MemoryObjectLogProvider } from '../providers/memory-provider';
import { SyncGenerationProvisionRepository } from './repository';
import { PendingSyncGenerationProvisioner } from './sync-generation-provisioner';

const NOW = '2026-08-15T12:00:00.000Z';
const PROJECT_ID = 'project-cloud-pending';
const PROJECT_SYNC_ID = 'project-sync-cloud-pending';
const SYNC_GENERATION_ID = 'sync-generation-cloud-pending';
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-sync-generation-provision-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();

  const authorityRepository = createSyncAppAuthorityRepository(db);
  const authorityAttempt = await authorityRepository.begin({
    targetMode: 'google-drive',
    accountSubjectId: 'google-subject',
    credentialSecretRef: 'native:google-credential',
    attemptId: 'empty-cloud-connect',
    nowIso: NOW,
  });
  await authorityRepository.complete({
    attemptId: authorityAttempt.attemptId,
    providerAccountId: 'google-account',
    bindings: [],
    nowIso: NOW,
  });

  const run = createAuthoredTransactionRunner({
    database: () => db,
    identity: async () => ({
      installationId: 'installation-provision',
      createWriterIdentity: () => ({ writerId: 'writer-provision', writerEpoch: 'epoch-1' }),
    }),
    clock: () => ({ nowMs: Date.parse(NOW), nowIso: NOW }),
    syncGenerationIds: {
      createSyncGenerationId: () => SYNC_GENERATION_ID,
      createProjectSyncId: () => PROJECT_SYNC_ID,
    },
  });
  await run(PROJECT_ID, 'project.create', async ({ tx, changes }) => {
    await tx.insert(ProjectTable).values({
      id: PROJECT_ID,
      userId: 'local-user',
      name: 'Cloud pending',
      createdAt: NOW,
      updatedAt: NOW,
    });
    appendAuthoredDomainMutation(changes, {
      entityType: 'project',
      mutationType: 'create',
      entityId: PROJECT_ID,
      projectId: PROJECT_ID,
      payload: { id: PROJECT_ID, name: 'Cloud pending', summary: '' },
    });
  });

  const objects = new MemoryProviderLocalObjectStore();
  const provider = new MemoryObjectLogProvider(objects);
  let objectSequence = 1;
  const codec = new PlaintextSyncEngineObjectCodec({
    allocate: () => objects.ref(`provision.${objectSequence++}`),
    read: (ref, signal) => objects.read(ref, signal),
    write: (ref, bytes, signal) => objects.write(ref, bytes, signal),
  });
  const blobPort: SyncEngineBlobPort = {
    async prepareOutbound() {
      throw new Error('No assets in provisioning fixture');
    },
    async verifyAndInstallInbound() {
      throw new Error('Inbound assets are outside provisioning');
    },
  };
  const repository = new SyncGenerationProvisionRepository(db, () => NOW);
  const emitAuthorityChanged = vi.fn();
  const provisioner = new PendingSyncGenerationProvisioner({
    db,
    repository,
    createProvider: () => provider,
    createSnapshotPublisher: ({ pending, provider: target, providerGeneration }) =>
      new ProviderSnapshotPublisher({
        db,
        projectId: pending.projectId,
        syncGenerationId: pending.syncGenerationId,
        provider: target,
        providerGeneration,
        objectCodec: codec,
        blobPort,
        assetCapturePort: {
          async captureCanonicalSource() {
            throw new Error('No assets in provisioning fixture');
          },
        },
        nowMs: () => Date.parse(NOW),
        nowIso: () => NOW,
      }),
    emitAuthorityChanged,
  });
  return {
    db,
    gateway,
    run,
    provider,
    repository,
    provisioner,
    emitAuthorityChanged,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('post-connect SyncGeneration provisioning', () => {
  it('keeps local edits usable while pending, then publishes plaintext genesis before runtime activation', async () => {
    const fixture = await setup();
    expect(await fixture.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { syncGenerationId: SYNC_GENERATION_ID, state: 'connecting', connectedAt: null },
    ]);
    expect(
      await createSyncAppAuthorityRepository(fixture.db).listActiveRuntimeBindings(),
    ).toEqual([]);

    await fixture.run(PROJECT_ID, 'project.rename', async ({ tx, changes }) => {
      await tx
        .update(ProjectTable)
        .set({ name: 'Edited while pending', updatedAt: NOW })
        .where(eq(ProjectTable.id, PROJECT_ID));
      appendAuthoredDomainMutation(changes, {
        entityType: 'project',
        mutationType: 'update',
        entityId: PROJECT_ID,
        projectId: PROJECT_ID,
        payload: { name: 'Edited while pending' },
      });
    });
    expect(await fixture.db.select().from(SyncChangeSetTable)).toHaveLength(2);

    const [pending] = await fixture.repository.ensureAndListPending('google-drive');
    expect(pending).toMatchObject({
      syncGenerationId: SYNC_GENERATION_ID,
      projectSyncId: PROJECT_SYNC_ID,
      generationNumber: 1,
      bindingState: 'connecting',
    });
    await fixture.provisioner.provision(pending!, new AbortController().signal);

    expect(await fixture.db.select().from(SyncGenerationTable)).toMatchObject([
      {
        syncGenerationId: SYNC_GENERATION_ID,
        projectSyncId: PROJECT_SYNC_ID,
        generationNumber: 1,
        status: 'active',
      },
    ]);
    expect(await fixture.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { syncGenerationId: SYNC_GENERATION_ID, state: 'ready', connectedAt: NOW },
    ]);
    expect(await fixture.db.select().from(SyncCheckpointTable)).toMatchObject([
      { syncGenerationId: SYNC_GENERATION_ID, kind: 'genesis', state: 'published' },
    ]);
    expect(await fixture.db.select().from(SyncTransferTable)).toHaveLength(2);

    const generation = await fixture.provider.openGeneration(pending!.binding);
    const inventory = await fixture.provider.listInventory({ generation });
    expect(inventory.objects.map(({ objectKind }) => objectKind).sort()).toEqual([
      'genesis',
      'snapshot-commit',
    ]);
    expect(
      await createSyncAppAuthorityRepository(fixture.db).listActiveRuntimeBindings(),
    ).toMatchObject([{ binding: { syncGenerationId: SYNC_GENERATION_ID } }]);
    expect(fixture.emitAuthorityChanged).toHaveBeenCalledOnce();
    expect(fixture.gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('reconciles a lost marker response and never duplicates remote immutable objects', async () => {
    const fixture = await setup();
    const upload = fixture.provider.uploadImmutable.bind(fixture.provider);
    let loseMarkerResponse = true;
    vi.spyOn(fixture.provider, 'uploadImmutable').mockImplementation(async (input) => {
      const result = await upload(input);
      if (input.objectKind === 'snapshot-commit' && loseMarkerResponse) {
        loseMarkerResponse = false;
        throw new Error('injected marker response loss');
      }
      return result;
    });

    const [first] = await fixture.repository.ensureAndListPending('google-drive');
    await expect(
      fixture.provisioner.provision(first!, new AbortController().signal),
    ).rejects.toThrow('injected marker response loss');
    expect(await fixture.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'connecting', connectedAt: null },
    ]);

    const [retry] = await fixture.repository.ensureAndListPending('google-drive');
    await fixture.provisioner.provision(retry!, new AbortController().signal);
    const generation = await fixture.provider.openGeneration(retry!.binding);
    expect((await fixture.provider.listInventory({ generation })).objects).toHaveLength(2);
    expect(await fixture.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'ready' },
    ]);
    const markerTransfer = (await fixture.db.select().from(SyncTransferTable)).find(
      ({ objectKind }) => objectKind === 'snapshot-commit',
    );
    expect(markerTransfer).toMatchObject({ state: 'completed', attemptCount: 2 });
    expect(fixture.emitAuthorityChanged).toHaveBeenCalledOnce();
  });

  it('reuses the published marker after a crash before the ready binding commit', async () => {
    const fixture = await setup();
    const markReady = fixture.repository.markReady.bind(fixture.repository);
    const markReadySpy = vi.spyOn(fixture.repository, 'markReady')
      .mockRejectedValueOnce(new Error('injected crash before ready binding commit'))
      .mockImplementation(markReady);

    const [first] = await fixture.repository.ensureAndListPending('google-drive');
    await expect(
      fixture.provisioner.provision(first!, new AbortController().signal),
    ).rejects.toThrow('injected crash before ready');
    expect(await fixture.db.select().from(SyncCheckpointTable)).toMatchObject([
      { kind: 'genesis', state: 'published' },
    ]);
    expect(await fixture.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'connecting', connectedAt: null },
    ]);

    const [retry] = await fixture.repository.ensureAndListPending('google-drive');
    await fixture.provisioner.provision(retry!, new AbortController().signal);
    const generation = await fixture.provider.openGeneration(retry!.binding);
    expect((await fixture.provider.listInventory({ generation })).objects).toHaveLength(2);
    expect(await fixture.db.select().from(SyncCheckpointTable)).toHaveLength(1);
    expect(await fixture.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'ready' },
    ]);
    expect(markReadySpy).toHaveBeenCalledTimes(2);
    expect(fixture.emitAuthorityChanged).toHaveBeenCalledOnce();
  });
});
