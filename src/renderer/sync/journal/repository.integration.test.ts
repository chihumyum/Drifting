import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { asc } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../../lib/db';
import {
  ProjectTable,
  SyncApplyReceiptTable,
  SyncChangeSetTable,
  SyncMutationTable,
  SyncGenerationTable,
  SyncGenerationWriterStateTable,
} from '../../schema/drizzle';
import {
  decodeCanonicalCbor,
  decodeSyncChangeSetV1,
} from '../protocol';
import { SyncChangeBuilder } from './change-builder';
import { recordAuthoredChangeSetInTransaction } from './repository';
import type { SyncWriterIdentitySource } from './writer-state';

const PROJECT_ID = 'project-journal';
const SYNC_GENERATION_ID = 'sync-generation-journal';
const PROJECT_SYNC_ID = 'projectSync-journal';
const NOW = '2026-08-15T00:00:00.000Z';
const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

async function createDatabase(): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-sync-journal-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: 'local-user',
    name: 'Journal project',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(SyncGenerationTable).values({
    syncGenerationId: SYNC_GENERATION_ID,
    projectId: PROJECT_ID,
    projectSyncId: PROJECT_SYNC_ID,
    generationNumber: 1,
    protocolVersion: 1,
    domainSchemaVersion: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return db;
}

function identity(
  installationId: string,
  writerId: string,
  writerEpoch: string,
): SyncWriterIdentitySource {
  let generation = 0;
  return {
    installationId,
    createWriterIdentity() {
      generation += 1;
      return {
        writerId: generation === 1 ? writerId : `${writerId}-${generation}`,
        writerEpoch: generation === 1 ? writerEpoch : `${writerEpoch}-${generation}`,
      };
    },
  };
}

function builder(value: string): SyncChangeBuilder {
  const changes = new SyncChangeBuilder();
  changes.add({
    action: 'field.set',
    target: { family: 'entity', kind: 'node', id: 'node-1', incarnation: 0 },
    payload: { field: 'title', value },
  });
  return changes;
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('SyncEngine journal repository', () => {
  it('commits an atomic authored change set and rolls sequence/HLC back with its transaction', async () => {
    const db = await createDatabase();
    const localIdentity = identity('installation-a', 'writer-a', 'epoch-a');
    await expect(
      db.transaction((tx) =>
        recordAuthoredChangeSetInTransaction(
          tx,
          {
            projectId: PROJECT_ID,
            projectSyncId: PROJECT_SYNC_ID,
            syncGenerationId: SYNC_GENERATION_ID,
            identity: localIdentity,
            clock: { nowMs: 50, nowIso: '2026-08-15T00:00:00.050Z' },
          },
          new SyncChangeBuilder(),
        ),
      ),
    ).rejects.toThrow(/at least one sync mutation/u);
    expect(await db.select().from(SyncGenerationWriterStateTable)).toEqual([]);
    expect(await db.select().from(SyncChangeSetTable)).toEqual([]);

    const first = await db.transaction((tx) =>
      recordAuthoredChangeSetInTransaction(
        tx,
        {
          projectId: PROJECT_ID,
          projectSyncId: PROJECT_SYNC_ID,
          syncGenerationId: SYNC_GENERATION_ID,
          identity: localIdentity,
          clock: { nowMs: 100, nowIso: '2026-08-15T00:00:00.100Z' },
        },
        builder('first'),
      ),
    );
    expect(first.changeSet).toMatchObject({
      changeSetId: 'writer-a:epoch-a:1',
      deviceSeq: 1,
      hlc: { wallMs: 100, counter: 0 },
    });
    expect(await decodeSyncChangeSetV1(first.encodedBytes)).toMatchObject({
      ok: true,
      value: { changeSetId: 'writer-a:epoch-a:1' },
    });

    await expect(
      db.transaction(async (tx) => {
        await recordAuthoredChangeSetInTransaction(
          tx,
          {
            projectId: PROJECT_ID,
            projectSyncId: PROJECT_SYNC_ID,
            syncGenerationId: SYNC_GENERATION_ID,
            identity: localIdentity,
            clock: { nowMs: 90, nowIso: '2026-08-15T00:00:00.200Z' },
          },
          builder('rolled back'),
        );
        throw new Error('rollback journal transaction');
      }),
    ).rejects.toThrow(/rollback journal/u);

    const second = await db.transaction((tx) =>
      recordAuthoredChangeSetInTransaction(
        tx,
        {
          projectId: PROJECT_ID,
          projectSyncId: PROJECT_SYNC_ID,
          syncGenerationId: SYNC_GENERATION_ID,
          identity: localIdentity,
          clock: { nowMs: 90, nowIso: '2026-08-15T00:00:00.300Z' },
        },
        builder('second'),
      ),
    );
    expect(second.changeSet).toMatchObject({
      changeSetId: 'writer-a:epoch-a:2',
      deviceSeq: 2,
      hlc: { wallMs: 100, counter: 1 },
    });

    const changeSets = await db
      .select()
      .from(SyncChangeSetTable)
      .orderBy(asc(SyncChangeSetTable.deviceSeq));
    expect(changeSets).toHaveLength(2);
    expect(changeSets.map(({ origin, applyState }) => [origin, applyState])).toEqual([
      ['local', 'applied'],
      ['local', 'applied'],
    ]);
    expect(changeSets[0].payloadSha256).toBe(first.encodedSha256.slice('sha256:'.length));
    expect(await db.select().from(SyncApplyReceiptTable)).toHaveLength(2);

    const mutations = await db
      .select()
      .from(SyncMutationTable)
      .orderBy(asc(SyncMutationTable.changeSetId));
    expect(mutations).toHaveLength(2);
    expect(mutations[0].payloadSha256).toBe(
      first.changeSet.mutations[0].payloadSha256.slice('sha256:'.length),
    );
    expect(decodeCanonicalCbor(mutations[0].payloadCbor as Uint8Array)).toMatchObject({
      ok: true,
      value: { field: 'title', value: 'first' },
    });
    expect(await db.select().from(SyncGenerationWriterStateTable)).toMatchObject([
      { writerId: 'writer-a', writerEpoch: 'epoch-a', nextDeviceSeq: 3 },
    ]);
  });

  it('rotates writer identity on installation mismatch without reusing sequence or HLC', async () => {
    const db = await createDatabase();
    const installationA = identity('installation-a', 'writer-a', 'epoch-a');
    const installationB = identity('installation-b', 'writer-b', 'epoch-b');
    const record = (source: SyncWriterIdentitySource, nowMs: number, nowIso: string) =>
      db.transaction((tx) =>
        recordAuthoredChangeSetInTransaction(
          tx,
          {
            projectId: PROJECT_ID,
            projectSyncId: PROJECT_SYNC_ID,
            syncGenerationId: SYNC_GENERATION_ID,
            identity: source,
            clock: { nowMs, nowIso },
          },
          builder(nowIso),
        ),
      );

    expect((await record(installationA, 100, '2026-08-15T00:00:00.100Z')).changeSet).toMatchObject({
      writerId: 'writer-a',
      deviceSeq: 1,
      hlc: { wallMs: 100, counter: 0 },
    });
    expect((await record(installationA, 90, '2026-08-15T00:00:00.200Z')).changeSet).toMatchObject({
      writerId: 'writer-a',
      deviceSeq: 2,
      hlc: { wallMs: 100, counter: 1 },
    });
    expect((await record(installationB, 80, '2026-08-15T00:00:00.300Z')).changeSet).toMatchObject({
      writerId: 'writer-b',
      writerEpoch: 'epoch-b',
      deviceSeq: 1,
      hlc: { wallMs: 100, counter: 2 },
    });

    const writers = await db
      .select()
      .from(SyncGenerationWriterStateTable)
      .orderBy(asc(SyncGenerationWriterStateTable.createdAt));
    expect(writers).toMatchObject([
      { writerId: 'writer-a', nextDeviceSeq: 3, retiredAt: '2026-08-15T00:00:00.300Z' },
      { writerId: 'writer-b', nextDeviceSeq: 2, retiredAt: null },
    ]);
  });

});
