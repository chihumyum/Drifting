import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  ProjectTable,
  ProjectAssetTable,
  SyncConnectAttemptTable,
  SyncGenerationTable,
  yjsUpdates,
} from '../../schema/drizzle';
import { createSyncAppAuthorityRepository } from '../app-authority-repository';
import { cancelPendingGoogleDriveTransition } from './pending-transition-cancel';

const NOW = '2026-08-15T12:00:00.000Z';
const LATER = '2026-08-15T12:01:00.000Z';
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

async function setup(includeRemoteProject = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-transition-cancel-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: 'project-local',
    userId: 'local-user',
    name: 'Local project',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(SyncGenerationTable).values({
    syncGenerationId: 'sync-generation-local',
    projectId: 'project-local',
    projectSyncId: 'project-sync-local',
    generationNumber: 1,
    protocolVersion: 1,
    domainSchemaVersion: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(ProjectAssetTable).values({
    id: 'asset-local',
    projectId: 'project-local',
    kind: 'image',
    sourceMime: 'image/png',
    sourceSizeBytes: 1,
    sourceSha256: 'a'.repeat(64),
    width: 1,
    height: 1,
    createdAt: NOW,
  });
  await db.insert(yjsUpdates).values({
    docId: 'node:local:content',
    updateBlob: new Uint8Array([1]),
    createdAt: NOW,
  });
  const repository = createSyncAppAuthorityRepository(db);
  const attempt = await repository.begin({
    targetMode: 'google-drive',
    accountSubjectId: 'google-subject',
    credentialSecretRef: 'native:google-credential',
    attemptId: 'connect-attempt',
    nowIso: NOW,
  });
  if (includeRemoteProject) {
    await repository.stageRestoreSyncGeneration({
      attemptId: attempt.attemptId,
      syncGenerationId: 'sync-generation-remote-staged',
      projectSyncId: 'project-sync-remote',
      projectId: 'project-remote',
      nowIso: NOW,
    });
  }
  const revokeCredential = vi.fn(async () => undefined);
  const emitAuthorityChanged = vi.fn();
  return {
    db,
    gateway,
    repository,
    attempt,
    revokeCredential,
    emitAuthorityChanged,
    dependencies: {
      db,
      revokeCredential,
      emitAuthorityChanged,
      nowIso: () => LATER,
    },
  };
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('pending Google Drive transition cancellation', () => {
  it('revokes before cancelling first connect and preserves the local project/SyncGeneration', async () => {
    const input = await setup();
    await expect(cancelPendingGoogleDriveTransition(input.dependencies)).resolves.toMatchObject({
      status: 'cancelled',
      kind: 'connect',
    });
    expect(input.revokeCredential).toHaveBeenCalledExactlyOnceWith(
      'native:google-credential',
      expect.any(AbortSignal),
    );
    expect(await input.repository.read()).toMatchObject({
      mode: 'local',
      transitionState: 'stable',
    });
    expect(await input.db.select().from(ProjectTable)).toHaveLength(1);
    expect(await input.db.select().from(ProjectAssetTable)).toHaveLength(1);
    expect(await input.db.select().from(yjsUpdates)).toHaveLength(1);
    expect(await input.db.select().from(SyncGenerationTable)).toMatchObject([
      { syncGenerationId: 'sync-generation-local', status: 'active', projectId: 'project-local' },
    ]);
  });

  it('retires only unactivated discovered projects and keeps a failed revoke resumable', async () => {
    const input = await setup(true);
    input.revokeCredential.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'OFFLINE' }));
    await expect(cancelPendingGoogleDriveTransition(input.dependencies)).rejects.toThrow('offline');
    expect(await input.repository.read()).toMatchObject({
      mode: 'local',
      transitionState: 'blocked',
      attemptId: input.attempt.attemptId,
    });

    await cancelPendingGoogleDriveTransition(input.dependencies);
    expect(
      await input.db
        .select({ syncGenerationId: SyncGenerationTable.syncGenerationId, projectId: SyncGenerationTable.projectId, status: SyncGenerationTable.status })
        .from(SyncGenerationTable),
    ).toEqual([
      { syncGenerationId: 'sync-generation-local', projectId: 'project-local', status: 'active' },
      { syncGenerationId: 'sync-generation-remote-staged', projectId: null, status: 'retired' },
    ]);
    expect(
      await input.db
        .select({ state: SyncConnectAttemptTable.state })
        .from(SyncConnectAttemptTable)
        .where(eq(SyncConnectAttemptTable.attemptId, input.attempt.attemptId)),
    ).toEqual([{ state: 'cancelled' }]);
    expect(await input.db.select().from(ProjectAssetTable)).toHaveLength(1);
    expect(await input.db.select().from(yjsUpdates)).toHaveLength(1);
  });
});
