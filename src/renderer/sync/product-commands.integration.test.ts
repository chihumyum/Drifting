import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { events } from '../lib/events';
import {
  ProjectTable,
  SyncProviderBindingTable,
  SyncRemoteObjectTable,
  SyncGenerationTable,
} from '../schema/drizzle';
import { createSyncAppAuthorityRepository } from './app-authority-repository';
import {
  ProductSyncCommandService,
  type ProductSyncCommandDependencies,
} from './product-commands';

const NOW = '2026-08-15T12:00:00.000Z';
const LATER = '2026-08-15T12:01:00.000Z';
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-product-sync-commands-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: 'project-1',
    userId: 'local-user',
    name: 'Project',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(SyncGenerationTable).values({
    syncGenerationId: 'sync-generation-1',
    projectId: 'project-1',
    projectSyncId: 'project-sync-1',
    generationNumber: 1,
    protocolVersion: 1,
    domainSchemaVersion: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  const authority = createSyncAppAuthorityRepository(db);
  const attempt = await authority.begin({
    targetMode: 'google-drive',
    accountSubjectId: 'subject-1',
    credentialSecretRef: 'secret:credential',
    attemptId: 'connect-1',
    nowIso: NOW,
  });
  await db.insert(SyncRemoteObjectTable).values({
    id: 'marker-1',
    syncGenerationId: 'sync-generation-1',
    providerObjectId: 'provider-marker-1',
    logicalKeyId: 'logical-marker-1',
    objectKind: 'snapshot-commit',
    storedSha256: '0'.repeat(64),
    sizeBytes: 1,
    firstObservedAt: NOW,
    lastObservedAt: NOW,
  });
  await authority.markSyncGenerationCommitted({
    attemptId: attempt.attemptId,
    sourceSyncGenerationId: 'sync-generation-1',
    commitMarkerObjectId: 'marker-1',
    nowIso: NOW,
  });
  await authority.complete({
    attemptId: attempt.attemptId,
    providerAccountId: 'account-1',
    bindings: [{
      syncGenerationId: 'sync-generation-1',
      providerNamespace: 'appDataFolder',
      providerGenerationRef: 'syncdrive:sync-generation-1',
    }],
    nowIso: NOW,
  });
  const dependencies: ProductSyncCommandDependencies = {
    database: () => db,
    connectGoogleDrive: vi.fn(async () => ({
      status: 'connected' as const,
      attemptId: 'pending-connect',
      accountSubject: 'subject-1',
      restored: [],
      connectedLocalSyncGenerationIds: ['sync-generation-1'],
    })),
    reauthorizeGoogleDrive: vi.fn(async (credentialSecretRef) => ({
      accountSubject: 'subject-1',
      credentialSecretRef,
    })),
    disconnectGoogleDrive: vi.fn(async () => undefined),
    cancelPendingGoogleDrive: vi.fn(async () => undefined),
    triggerManual: vi.fn(),
    requestProvisioning: vi.fn(() => true),
    emitAuthorityChanged: vi.fn(),
    nowIso: () => LATER,
  };
  return { db, gateway, dependencies, service: new ProductSyncCommandService(dependencies) };
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('ProductSyncCommandService', () => {
  it('routes one Google Drive action through OAuth, discovery, restore, and publication composition', async () => {
    const input = await setup();
    const signal = new AbortController().signal;
    await expect(input.service.connectGoogleDrive(signal)).resolves.toMatchObject({
      status: 'connected',
      connectedLocalSyncGenerationIds: ['sync-generation-1'],
    });
    expect(input.dependencies.connectGoogleDrive).toHaveBeenCalledWith(input.db, signal);
  });

  it('announces freshly restored projects so device-local tabs can be discarded', async () => {
    const input = await setup();
    vi.mocked(input.dependencies.connectGoogleDrive).mockResolvedValueOnce({
      status: 'connected',
      attemptId: 'pending-connect',
      accountSubject: 'subject-1',
      restored: [
        {
          projectId: 'project-restored',
          projectSyncId: 'project-sync-restored',
          syncGenerationId: 'sync-generation-restored',
          snapshotId: 'snapshot-restored',
        },
      ],
      connectedLocalSyncGenerationIds: [],
    });
    const listener = vi.fn();
    events.on('sync:projects-restored', listener);
    try {
      await input.service.connectGoogleDrive(new AbortController().signal);
      expect(listener).toHaveBeenCalledWith({ projectIds: ['project-restored'] });
    } finally {
      events.off('sync:projects-restored', listener);
    }
  });

  it('pauses and resumes every SyncGeneration atomically and emits one authority reload', async () => {
    const input = await setup();
    await input.service.setPaused(true);
    expect((await input.db.select().from(SyncProviderBindingTable))[0]).toMatchObject({
      state: 'paused',
      updatedAt: LATER,
    });
    await input.service.setPaused(false);
    expect((await input.db.select().from(SyncProviderBindingTable))[0]).toMatchObject({
      state: 'ready',
    });
    expect(input.dependencies.emitAuthorityChanged).toHaveBeenCalledTimes(2);
  });

  it('routes App-wide disconnect through the production composition boundary', async () => {
    const input = await setup();
    const signal = new AbortController().signal;
    await input.service.disconnectGoogleDrive(signal);
    expect(input.dependencies.disconnectGoogleDrive).toHaveBeenCalledWith(input.db, signal);
  });

  it('routes pending connection cancellation through native revoke composition', async () => {
    const input = await setup();
    const signal = new AbortController().signal;
    await input.service.cancelPendingGoogleDrive(signal);
    expect(input.dependencies.cancelPendingGoogleDrive).toHaveBeenCalledWith(input.db, signal);
  });

  it('reauthorizes the same native secret and remounts only needs-reauth SyncGenerations', async () => {
    const input = await setup();
    await input.db
      .update(SyncProviderBindingTable)
      .set({ state: 'needs-reauth', updatedAt: NOW });
    await input.service.reauthorizeGoogleDrive();
    expect(input.dependencies.reauthorizeGoogleDrive).toHaveBeenCalledWith('secret:credential');
    expect(await input.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'ready', updatedAt: LATER },
    ]);
    expect(input.dependencies.emitAuthorityChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps needs-reauth durable when native identity does not match', async () => {
    const input = await setup();
    await input.db
      .update(SyncProviderBindingTable)
      .set({ state: 'needs-reauth', updatedAt: NOW });
    vi.mocked(input.dependencies.reauthorizeGoogleDrive).mockResolvedValueOnce({
      accountSubject: 'another-subject',
      credentialSecretRef: 'secret:credential',
    });
    await expect(input.service.reauthorizeGoogleDrive()).rejects.toThrow(
      'another account or secret reference',
    );
    expect(await input.db.select().from(SyncProviderBindingTable)).toMatchObject([
      { state: 'needs-reauth' },
    ]);
    expect(input.dependencies.emitAuthorityChanged).not.toHaveBeenCalled();
  });
});
