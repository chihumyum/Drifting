import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { installHeadlessDatabaseClient } from '../lib/db';
import { events } from '../lib/events';
import {
  ProjectTable,
  SyncProviderBindingTable,
  SyncRemoteObjectTable,
  SyncGenerationTable,
} from '../schema/drizzle';
import { createSyncAppAuthorityRepository } from './app-authority-repository';
import {
  installProductSyncAuthorityMonitor,
  ProductSyncAuthorityStore,
} from './product-authority-store';

const NOW = '2026-08-15T10:00:00.000Z';
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) gateway.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-product-sync-authority-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: 'project-a',
    userId: 'local-user',
    name: 'Project A',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(SyncGenerationTable).values({
    syncGenerationId: 'sync-generation-a',
    projectId: 'project-a',
    projectSyncId: 'project-sync-a',
    generationNumber: 1,
    protocolVersion: 1,
    domainSchemaVersion: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { db, store: new ProductSyncAuthorityStore() };
}

describe('ProductSyncAuthorityStore', () => {
  it('waits for database readiness and blocks refreshes again after a database error', async () => {
    const { db, store } = await setup();
    const refresh = vi.spyOn(store, 'refresh').mockResolvedValue();
    const reset = vi.spyOn(store, 'reset');
    const stop = installProductSyncAuthorityMonitor(store);

    expect(refresh).not.toHaveBeenCalled();

    const uninstallDatabase = installHeadlessDatabaseClient(db);
    try {
      events.emit('db:ready');
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenLastCalledWith(db);

      events.emit('db:error', { error: 'synthetic open failure' });
      expect(reset).toHaveBeenCalledTimes(1);
      events.emit('sync:authority-changed');
      events.emit('sync:runtime-state-changed');
      expect(refresh).toHaveBeenCalledTimes(1);

      events.emit('db:ready');
      expect(refresh).toHaveBeenCalledTimes(2);

      stop();
      events.emit('sync:authority-changed');
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      uninstallDatabase();
    }
  });

  it('maps durable App authority and binding states without exposing credentials', async () => {
    const { db, store } = await setup();
    await store.refresh(db);
    expect(store.getSnapshot()).toMatchObject({
      status: 'local',
      mode: 'local',
      transitionKind: null,
      activeSyncGenerations: 1,
      readySyncGenerations: 0,
    });

    const authority = createSyncAppAuthorityRepository(db, {
      createAttemptId: () => 'connect-a',
      createProviderAccountId: () => 'account-a',
      createTargetSyncGenerationId: () => 'unused-target',
    });
    const attempt = await authority.begin({
      targetMode: 'google-drive',
      accountSubjectId: 'opaque-google-subject',
      credentialSecretRef: 'native:google-secret',
      nowIso: NOW,
    });
    await db.insert(SyncRemoteObjectTable).values({
      id: 'marker-a',
      syncGenerationId: 'sync-generation-a',
      providerObjectId: 'provider-marker-a',
      logicalKeyId: `sha256:${'a'.repeat(64)}`,
      objectKind: 'snapshot-commit',
      storedSha256: '0'.repeat(64),
      sizeBytes: 1,
      firstObservedAt: NOW,
      lastObservedAt: NOW,
    });
    await authority.markSyncGenerationCommitted({
      attemptId: attempt.attemptId,
      sourceSyncGenerationId: 'sync-generation-a',
      commitMarkerObjectId: 'marker-a',
      nowIso: NOW,
    });
    await authority.complete({
      attemptId: attempt.attemptId,
      providerAccountId: 'account-a',
      bindings: [
        { syncGenerationId: 'sync-generation-a', providerNamespace: 'appDataFolder', providerGenerationRef: null },
      ],
      nowIso: NOW,
    });

    await store.refresh(db);
    expect(store.getSnapshot()).toMatchObject({
      status: 'cloud-ready',
      mode: 'google-drive',
      readySyncGenerations: 1,
    });
    expect(JSON.stringify(store.getSnapshot())).not.toMatch(
      /opaque-google-subject|native:google-secret|native:sync-generation-key/u,
    );

    for (const [state, status] of [
      ['publishing-genesis', 'cloud-provisioning'],
      ['paused', 'cloud-paused'],
      ['needs-reauth', 'cloud-attention'],
    ] as const) {
      await db
        .update(SyncProviderBindingTable)
        .set({ state, updatedAt: NOW })
        .where(eq(SyncProviderBindingTable.syncGenerationId, 'sync-generation-a'));
      await store.refresh(db);
      expect(store.getSnapshot().status).toBe(status);
    }

    await db
      .update(SyncProviderBindingTable)
      .set({ state: 'ready', updatedAt: NOW })
      .where(eq(SyncProviderBindingTable.syncGenerationId, 'sync-generation-a'));
    const disconnect = await authority.begin({
      targetMode: 'local',
      attemptId: 'disconnect-a',
      nowIso: NOW,
    });
    await authority.block({
      attemptId: disconnect.attemptId,
      errorCode: 'OFFLINE',
      nowIso: NOW,
    });
    await store.refresh(db);
    expect(store.getSnapshot()).toMatchObject({
      status: 'cloud-attention',
      mode: 'google-drive',
      targetMode: 'local',
      transitionKind: 'disconnect',
      errorCode: 'OFFLINE',
    });
  });
});
