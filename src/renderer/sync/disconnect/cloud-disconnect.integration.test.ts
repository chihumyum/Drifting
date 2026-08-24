import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  clearGoogleDriveOperationTracesForTests,
  getSanitizedGoogleDriveOperationTraces,
} from '../../services/diagnostics/google-drive-operation-trace';
import {
  ProjectTable,
  SyncProviderAccountTable,
  SyncProviderBindingTable,
  SyncRemoteObjectTable,
  SyncGenerationTable,
} from '../../schema/drizzle';
import { createSyncAppAuthorityRepository } from '../app-authority-repository';
import { CloudDisconnectOrchestrator, type CloudDisconnectDependencies } from './cloud-disconnect';

const NOW = '2026-08-15T12:00:00.000Z';
const LATER = '2026-08-15T12:01:00.000Z';
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

beforeEach(() => clearGoogleDriveOperationTracesForTests());

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-disconnect-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({ id: 'project-1', userId: 'local', name: 'Project', createdAt: NOW, updatedAt: NOW });
  await db.insert(SyncGenerationTable).values({
    syncGenerationId: 'sync-generation-1', projectId: 'project-1', projectSyncId: 'project-sync-1', generationNumber: 1,
    protocolVersion: 1, domainSchemaVersion: 1, status: 'active', createdAt: NOW, updatedAt: NOW,
  });
  const authority = createSyncAppAuthorityRepository(db);
  const connect = await authority.begin({
    targetMode: 'google-drive', accountSubjectId: 'subject', credentialSecretRef: 'secret:credential',
    attemptId: 'connect-1', nowIso: NOW,
  });
  await db.insert(SyncRemoteObjectTable).values({
    id: 'marker-1', syncGenerationId: 'sync-generation-1', providerObjectId: 'remote-marker', logicalKeyId: 'logical-marker',
    objectKind: 'snapshot-commit', storedSha256: '0'.repeat(64), sizeBytes: 1,
    firstObservedAt: NOW, lastObservedAt: NOW,
  });
  await authority.markSyncGenerationCommitted({
    attemptId: connect.attemptId, sourceSyncGenerationId: 'sync-generation-1', commitMarkerObjectId: 'marker-1', nowIso: NOW,
  });
  await authority.complete({
    attemptId: connect.attemptId,
    providerAccountId: 'account-1',
    bindings: [{ syncGenerationId: 'sync-generation-1', providerNamespace: 'appDataFolder', providerGenerationRef: 'syncdrive:sync-generation-1' }],
    nowIso: NOW,
  });
  const order: string[] = [];
  const dependencies: CloudDisconnectDependencies = {
    db,
    providerMode: 'google-drive',
    flushLocalDurability: vi.fn(async () => { order.push('flush'); }),
    waitForConvergence: vi.fn(async () => { order.push('converge'); }),
    revokeCredential: vi.fn(async () => { order.push('revoke'); }),
    emitAuthorityChanged: vi.fn(),
    nowIso: () => LATER,
  };
  return { db, authority, dependencies, order };
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('CloudDisconnectOrchestrator', () => {
  it('converges, revokes and switches to local without deleting local project state', async () => {
    const input = await setup();
    const result = await new CloudDisconnectOrchestrator(input.dependencies).disconnect();
    expect(result.status).toBe('disconnected');
    expect(input.order).toEqual(['flush', 'converge', 'revoke']);
    expect(await input.authority.read()).toMatchObject({ mode: 'local', transitionState: 'stable' });
    expect(await input.db.select().from(SyncProviderAccountTable)).toEqual([]);
    expect(await input.db.select().from(SyncProviderBindingTable)).toEqual([]);
    expect(await input.db.select().from(SyncGenerationTable)).toMatchObject([
      { syncGenerationId: 'sync-generation-1', status: 'active' },
    ]);
  });

  it('keeps a failed revoke as a durable blocked attempt and resumes idempotently', async () => {
    const input = await setup();
    const revoke = vi.mocked(input.dependencies.revokeCredential);
    revoke.mockRejectedValueOnce(Object.assign(new Error('network'), { code: 'OFFLINE' }));
    const orchestrator = new CloudDisconnectOrchestrator(input.dependencies);
    await expect(orchestrator.disconnect()).rejects.toThrow('network');
    expect(await input.authority.read()).toMatchObject({
      mode: 'google-drive',
      targetMode: 'local',
      transitionState: 'blocked',
    });
    const traces = getSanitizedGoogleDriveOperationTraces();
    expect(traces[traces.length - 1]?.events).toContainEqual(
      expect.objectContaining({
        layer: 'renderer-disconnect',
        phase: 'persist-blocked-attempt',
        outcome: 'passed',
      }),
    );
    await expect(orchestrator.disconnect()).resolves.toMatchObject({ status: 'disconnected' });
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(input.dependencies.waitForConvergence).toHaveBeenCalledTimes(1);
    expect(await input.authority.read()).toMatchObject({ mode: 'local', transitionState: 'stable' });
  });

  it('can leave a stalled provider locally without waiting on an unmounted runtime', async () => {
    const input = await setup();
    await input.db
      .update(SyncProviderBindingTable)
      .set({ state: 'blocked-corrupt', updatedAt: LATER });
    await new CloudDisconnectOrchestrator(input.dependencies).disconnect();
    expect(input.order).toEqual(['flush', 'revoke']);
    expect(input.dependencies.waitForConvergence).not.toHaveBeenCalled();
    expect(await input.authority.read()).toMatchObject({
      mode: 'local',
      transitionState: 'stable',
    });
    expect(await input.db.select().from(SyncGenerationTable)).toMatchObject([
      { syncGenerationId: 'sync-generation-1', status: 'active', projectId: 'project-1' },
    ]);
  });
});
