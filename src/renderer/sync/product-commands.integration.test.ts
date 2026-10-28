import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
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
    targetMode: 'hosted',
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
      providerNamespace: 'project-v1',
      providerGenerationRef: 'hosted:sync-generation-1',
    }],
    nowIso: NOW,
  });
  const dependencies: ProductSyncCommandDependencies = {
    database: () => db,
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






});
