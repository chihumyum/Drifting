import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  ProjectTable, SyncGenerationTable, SyncRemoteObjectTable, SyncLocalObjectTable,
  SyncQuarantinedObjectTable, SyncConflictTable, SyncFrontierGapTable, SyncReducerBaseTable,
} from '../../schema/drizzle';
import { createSyncAppAuthorityRepository } from '../app-authority-repository';
import { adoptDriveReplicaForHosted } from './adopt-drive';

const now = '2026-10-01T00:00:00.000Z';
const fixtures: Array<{ directory: string; gateway: ProductFileBackedSqliteGateway }> = [];
afterEach(async () => {
  for (const { gateway, directory } of fixtures.splice(0)) {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-drive-suspension-'));
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'library.db'));
  fixtures.push({ directory, gateway });
  const db = gateway.client();
  await db.insert(ProjectTable).values({ id: 'project', name: 'Synthetic local project', userId: 'local', createdAt: now, updatedAt: now });
  await db.insert(SyncGenerationTable).values({ syncGenerationId: 'drive-generation', projectId: 'project', projectSyncId: 'project-sync', generationNumber: 1, protocolVersion: 1, domainSchemaVersion: 1, status: 'active', createdAt: now, updatedAt: now });
  const authority = createSyncAppAuthorityRepository(db);
  const attempt = await authority.begin({ targetMode: 'google-drive', accountSubjectId: 'synthetic-drive', credentialSecretRef: 'synthetic-secret-ref', nowIso: now });
  await db.insert(SyncRemoteObjectTable).values({ id: 'remote', syncGenerationId: 'drive-generation', providerObjectId: 'synthetic-remote', logicalKeyId: 'synthetic-key', objectKind: 'snapshot-commit', storedSha256: '0'.repeat(64), sizeBytes: 1, firstObservedAt: now, lastObservedAt: now });
  await authority.markSyncGenerationCommitted({ attemptId: attempt.attemptId, sourceSyncGenerationId: 'drive-generation', commitMarkerObjectId: 'remote', nowIso: now });
  await authority.complete({ attemptId: attempt.attemptId, bindings: [{ syncGenerationId: 'drive-generation', providerNamespace: 'appDataFolder', providerGenerationRef: null }], nowIso: now });
  const adopt = (assertAccount = () => {}) => adoptDriveReplicaForHosted({ db, accountSubject: 'synthetic-hosted', identity: { installationId: 'synthetic-install', createWriterIdentity: () => ({ writerId: 'synthetic-writer', writerEpoch: 'synthetic-epoch' }) }, assertAccount, nowIso: now });
  const quarantine = async (remote: boolean) => {
    await db.insert(SyncLocalObjectTable).values({ id: 'quarantine-local', syncGenerationId: 'drive-generation', objectKind: 'quarantine', logicalKeyId: 'quarantined-key', storageRef: 'syncobj:synthetic-quarantine', storedSha256: '0'.repeat(64), sizeBytes: 1, codec: 'opaque', state: 'quarantined', createdAt: now });
    await db.insert(SyncQuarantinedObjectTable).values({ quarantineId: 'quarantine', syncGenerationId: 'drive-generation', remoteObjectId: remote ? 'remote' : null, localObjectId: 'quarantine-local', reason: 'object-codec-verification-failed', storedSha256: '0'.repeat(64), sizeBytes: 1, state: 'blocked-corrupt', createdAt: now });
  };
  return { db, authority, adopt, quarantine };
}

it('retains rejected remote Drive bytes and local projects while starting a clean Hosted generation', async () => {
  const fixture = await setup();
  await fixture.quarantine(true);
  const projects = await fixture.db.select().from(ProjectTable);
  const quarantine = await fixture.db.select().from(SyncQuarantinedObjectTable);
  const objects = await fixture.db.select().from(SyncLocalObjectTable);
  const result = await fixture.adopt();
  expect(result.syncGenerationIds).toHaveLength(1);
  expect(result.syncGenerationIds[0]).not.toBe('drive-generation');
  expect(await fixture.authority.read()).toMatchObject({ mode: 'local', transitionState: 'connecting', targetMode: 'hosted' });
  expect(await fixture.db.select().from(ProjectTable)).toEqual(projects);
  expect(await fixture.db.select().from(SyncQuarantinedObjectTable)).toEqual(quarantine);
  expect(await fixture.db.select().from(SyncLocalObjectTable)).toEqual(objects);
  expect(await fixture.db.select().from(SyncGenerationTable).where(eq(SyncGenerationTable.syncGenerationId, 'drive-generation'))).toMatchObject([{ status: 'retired' }]);
  expect(await fixture.authority.listActiveRuntimeBindings()).toEqual([]);
});

it.each(['local-quarantine', 'conflict', 'gap'] as const)('still rolls back takeover for unresolved local integrity: %s', async (kind) => {
  const fixture = await setup();
  if (kind === 'local-quarantine') await fixture.quarantine(false);
  if (kind === 'conflict') await fixture.db.insert(SyncConflictTable).values({ conflictId: 'conflict', syncGenerationId: 'drive-generation', kind: 'invariant', detailsCbor: new Uint8Array([0xa0]), state: 'open', createdAt: now });
  if (kind === 'gap') await fixture.db.insert(SyncFrontierGapTable).values({ id: 'gap', syncGenerationId: 'drive-generation', writerId: 'writer', writerEpoch: 'epoch', lane: 'applied', firstSeq: 1, lastSeq: 1, state: 'open', observedAt: now });
  const before = await fixture.authority.read();
  await expect(fixture.adopt()).rejects.toThrow('Resolve local sync conflicts');
  expect(await fixture.authority.read()).toEqual(before);
  expect(await fixture.db.select().from(SyncGenerationTable)).toMatchObject([{ syncGenerationId: 'drive-generation', status: 'active' }]);
});

it('refuses to adopt a generation restored from a compacted checkpoint', async () => {
  const fixture = await setup();
  await fixture.db.insert(SyncReducerBaseTable).values({ syncGenerationId: 'drive-generation', profileKey: 'synthetic-profile', payloadVersion: 2, pagesCbor: new Uint8Array([0x80]), sourceCheckpointId: 'synthetic-checkpoint', createdAt: now });
  const before = await fixture.authority.read();
  await expect(fixture.adopt()).rejects.toThrow('restored from a compacted checkpoint');
  expect(await fixture.authority.read()).toEqual(before);
  expect(await fixture.db.select().from(SyncGenerationTable)).toMatchObject([{ syncGenerationId: 'drive-generation', status: 'active' }]);
});

it('rolls back the entire adoption if account ownership changes before commit', async () => {
  const fixture = await setup();
  await fixture.quarantine(true);
  const before = await fixture.authority.read();
  let checks = 0;
  await expect(fixture.adopt(() => { if (++checks === 2) throw new Error('Account changed'); })).rejects.toThrow('Account changed');
  expect(await fixture.authority.read()).toEqual(before);
  expect(await fixture.db.select().from(SyncGenerationTable)).toHaveLength(1);
  expect(await fixture.db.select().from(SyncQuarantinedObjectTable)).toMatchObject([{ state: 'blocked-corrupt' }]);
});
