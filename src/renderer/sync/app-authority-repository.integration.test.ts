import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  ProjectTable,
  SyncConnectGenerationAttemptTable,
  SyncCursorTable,
  SyncProviderAccountTable,
  SyncProviderBindingTable,
  SyncRemoteObjectTable,
  SyncGenerationTable,
} from '../schema/drizzle';
import {
  createSyncAppAuthorityRepository,
  type SyncProviderTransitionIdSource,
} from './app-authority-repository';

const NOW = '2026-08-15T12:00:00.000Z';
const LATER = '2026-08-15T12:01:00.000Z';
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

const ids: SyncProviderTransitionIdSource = {
  createAttemptId: () => 'attempt-generated',
  createProviderAccountId: () => 'account-generated',
  createTargetSyncGenerationId: (() => {
    let next = 1;
    return () => `target-sync-generation-${next++}`;
  })(),
};

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-sync-authority-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  for (const suffix of ['a', 'b']) {
    await db.insert(ProjectTable).values({
      id: `project-${suffix}`,
      userId: 'local-user',
      name: `Project ${suffix}`,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(SyncGenerationTable).values({
      syncGenerationId: `sync-generation-${suffix}`,
      projectId: `project-${suffix}`,
      projectSyncId: `project-sync-${suffix}`,
      generationNumber: 1,
      protocolVersion: 1,
      domainSchemaVersion: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return { db, gateway, repository: createSyncAppAuthorityRepository(db, ids) };
}

async function addCommitMarker(
  db: Awaited<ReturnType<typeof setup>>['db'],
  syncGenerationId: string,
  markerId: string,
) {
  await db.insert(SyncRemoteObjectTable).values({
    id: markerId,
    syncGenerationId,
    providerObjectId: `provider-${markerId}`,
    logicalKeyId: `logical-${markerId}`,
    objectKind: 'snapshot-commit',
    storedSha256: '0'.repeat(64),
    sizeBytes: 1,
    firstObservedAt: NOW,
    lastObservedAt: NOW,
  });
}

async function connectGoogle(input: Awaited<ReturnType<typeof setup>>) {
  const attempt = await input.repository.begin({
    targetMode: 'google-drive',
    accountSubjectId: 'google-subject',
    credentialSecretRef: 'secret:google',
    attemptId: 'connect-google',
    nowIso: NOW,
  });
  for (const generation of attempt.generations) {
    const markerId = `marker-${generation.sourceSyncGenerationId}`;
    await addCommitMarker(input.db, generation.sourceSyncGenerationId, markerId);
    await input.repository.markSyncGenerationCommitted({
      attemptId: attempt.attemptId,
      sourceSyncGenerationId: generation.sourceSyncGenerationId,
      commitMarkerObjectId: markerId,
      nowIso: NOW,
    });
  }
  await input.repository.complete({
    attemptId: attempt.attemptId,
    providerAccountId: 'google-account',
    bindings: attempt.generations.map((generation) => ({
      syncGenerationId: generation.sourceSyncGenerationId,
      providerNamespace: 'appDataFolder',
      providerGenerationRef: `syncdrive:${generation.sourceSyncGenerationId}`,
    })),
    nowIso: NOW,
  });
  return attempt;
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('App-wide SyncEngine provider authority repository', () => {
  it('activates every local project immediately after its genesis marker is durable', async () => {
    const input = await setup();
    await connectGoogle(input);

    expect(await input.repository.read()).toMatchObject({
      mode: 'google-drive',
      generation: 2,
      transitionState: 'stable',
    });
    expect(await input.db.select().from(SyncProviderAccountTable)).toMatchObject([
      {
        id: 'google-account',
        providerKind: 'google-drive',
        accountSubjectId: 'google-subject',
        credentialSecretRef: 'secret:google',
      },
    ]);
    expect(
      (await input.repository.listActiveRuntimeBindings()).map(({ binding, providerGenerationRef }) => ({
        syncGenerationId: binding.syncGenerationId,
        providerGenerationRef,
      })),
    ).toEqual([
      {
        syncGenerationId: 'sync-generation-a',
        providerGenerationRef: 'syncdrive:sync-generation-a',
      },
      {
        syncGenerationId: 'sync-generation-b',
        providerGenerationRef: 'syncdrive:sync-generation-b',
      },
    ]);
    expect(input.gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps activation atomic when any project binding is omitted', async () => {
    const input = await setup();
    const attempt = await input.repository.begin({
      targetMode: 'google-drive',
      accountSubjectId: 'google-subject',
      credentialSecretRef: 'secret:google',
      attemptId: 'incomplete-connect',
      nowIso: NOW,
    });
    for (const generation of attempt.generations) {
      const markerId = `marker-${generation.sourceSyncGenerationId}`;
      await addCommitMarker(input.db, generation.sourceSyncGenerationId, markerId);
      await input.repository.markSyncGenerationCommitted({
        attemptId: attempt.attemptId,
        sourceSyncGenerationId: generation.sourceSyncGenerationId,
        commitMarkerObjectId: markerId,
        nowIso: NOW,
      });
    }

    await expect(
      input.repository.complete({
        attemptId: attempt.attemptId,
        bindings: [
          {
            syncGenerationId: 'sync-generation-a',
            providerNamespace: 'appDataFolder',
            providerGenerationRef: null,
          },
        ],
        nowIso: LATER,
      }),
    ).rejects.toThrow('every active SyncGeneration exactly once');
    expect(await input.db.select().from(SyncProviderAccountTable)).toEqual([]);
    expect(await input.db.select().from(SyncProviderBindingTable)).toEqual([]);
    expect(
      (await input.db.select().from(SyncConnectGenerationAttemptTable)).map(({ state }) => state),
    ).toEqual(['committed', 'committed']);
  });

  it('disconnects without deleting local projects, journals, or sync generations', async () => {
    const input = await setup();
    await connectGoogle(input);
    await input.db.insert(SyncCursorTable).values({
      syncGenerationId: 'sync-generation-a',
      providerEpoch: 'drive-v1',
      committedCursor: 'cursor-1',
      inventoryComplete: true,
      updatedAt: NOW,
    });

    const attempt = await input.repository.begin({
      targetMode: 'local',
      attemptId: 'disconnect-google',
      nowIso: LATER,
    });
    for (const generation of attempt.generations) {
      await input.repository.markSyncGenerationCommitted({
        attemptId: attempt.attemptId,
        sourceSyncGenerationId: generation.sourceSyncGenerationId,
        nowIso: LATER,
      });
    }
    await input.repository.complete({ attemptId: attempt.attemptId, nowIso: LATER });

    expect(await input.repository.read()).toMatchObject({
      mode: 'local',
      generation: 3,
      transitionState: 'stable',
    });
    expect(await input.db.select().from(SyncProviderAccountTable)).toEqual([]);
    expect(await input.db.select().from(SyncProviderBindingTable)).toEqual([]);
    expect(await input.db.select().from(SyncCursorTable)).toEqual([]);
    expect(
      await input.db
        .select({ syncGenerationId: SyncGenerationTable.syncGenerationId })
        .from(SyncGenerationTable)
        .where(eq(SyncGenerationTable.status, 'active')),
    ).toEqual([
      { syncGenerationId: 'sync-generation-a' },
      { syncGenerationId: 'sync-generation-b' },
    ]);
  });
});
