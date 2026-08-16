import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../../lib/db';
import {
  ProjectTable,
  BookNodeTable,
  NodeStorylineLinkTable,
  StorylineTable,
  SyncApplyReceiptTable,
  SyncChangeSetTable,
  SyncFieldClockTable,
  SyncMutationTable,
  SyncSetTagTable,
  SyncGenerationTable,
} from '../../schema/drizzle';
import { createAuthoredTransactionRunner, type AuthoredCommitEvent } from './authored-transaction';
import { appendAuthoredDomainMutation } from './domain-mutation';
import { appendAuthoredNodeStorylineProjectionInTransaction } from './storyline-membership';

const PROJECT_ID = 'project-authored';
const NOW = '2026-08-15T12:00:00.000Z';
const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

async function createDatabase(): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-authored-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: 'local-user',
    name: 'Before',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return db;
}

function runner(db: DbClient, events: AuthoredCommitEvent[] = []) {
  let writerGeneration = 0;
  return createAuthoredTransactionRunner({
    database: () => db,
    identity: async () => ({
      installationId: 'installation-test',
      createWriterIdentity: () => {
        writerGeneration += 1;
        return { writerId: `writer-${writerGeneration}`, writerEpoch: `epoch-${writerGeneration}` };
      },
    }),
    clock: () => ({ nowMs: 100, nowIso: NOW }),
    syncGenerationIds: {
      createSyncGenerationId: () => 'sync-generation-authored',
      createProjectSyncId: () => 'projectSync-authored',
    },
    onCommitted: (event) => events.push(event),
  });
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('runAuthoredTransaction', () => {
  it('creates the project SyncGeneration and commits one complete multi-mutation change-set', async () => {
    const db = await createDatabase();
    const events: AuthoredCommitEvent[] = [];
    const run = runner(db, events);

    await run(PROJECT_ID, 'project.rename', async ({ tx, changes, origin, generation }) => {
      expect(origin).toBe('local');
      expect(generation).toBeNull();
      await tx
        .update(ProjectTable)
        .set({ name: 'After', summary: 'Validated locally', updatedAt: NOW })
        .where(eq(ProjectTable.id, PROJECT_ID));
      appendAuthoredDomainMutation(changes, {
        entityType: 'project',
        mutationType: 'update',
        entityId: PROJECT_ID,
        projectId: PROJECT_ID,
        payload: {
          name: 'After',
          summary: 'Validated locally',
          optionalField: undefined,
        },
      });
    });

    expect(await db.select().from(SyncGenerationTable)).toMatchObject([
      { syncGenerationId: 'sync-generation-authored', projectSyncId: 'projectSync-authored', projectId: PROJECT_ID },
    ]);
    const changeSets = await db.select().from(SyncChangeSetTable);
    expect(changeSets).toHaveLength(1);
    expect(changeSets[0]).toMatchObject({ mutationCount: 2, applyState: 'applied' });
    expect(await db.select().from(SyncMutationTable)).toHaveLength(2);
    expect(await db.select().from(SyncApplyReceiptTable)).toHaveLength(1);
    expect(events).toEqual([
      {
        command: 'project.rename',
        projectId: PROJECT_ID,
        syncGenerationId: 'sync-generation-authored',
        changeSetId: 'writer-1:epoch-1:1',
      },
    ]);
  });

  it('rolls domain state, SyncGeneration creation, writer sequence, and journal back together', async () => {
    const db = await createDatabase();
    const run = runner(db);

    await expect(
      run(PROJECT_ID, 'project.rename', async ({ tx, changes }) => {
        await tx
          .update(ProjectTable)
          .set({ name: 'Must roll back' })
          .where(eq(ProjectTable.id, PROJECT_ID));
        appendAuthoredDomainMutation(changes, {
          entityType: 'project',
          mutationType: 'update',
          entityId: PROJECT_ID,
          projectId: PROJECT_ID,
          payload: { name: 'Must roll back' },
        });
        throw new Error('fault after domain write');
      }),
    ).rejects.toThrow('fault after domain write');

    expect((await db.select().from(ProjectTable))[0]?.name).toBe('Before');
    expect(await db.select().from(SyncGenerationTable)).toEqual([]);
    expect(await db.select().from(SyncChangeSetTable)).toEqual([]);
  });

  it('rejects a zero-mutation authored transaction and preserves a detached SyncGeneration purge', async () => {
    const db = await createDatabase();
    const run = runner(db);

    await expect(
      run(PROJECT_ID, 'project.noop', async ({ tx }) => {
        await tx
          .update(ProjectTable)
          .set({ name: 'Must also roll back' })
          .where(eq(ProjectTable.id, PROJECT_ID));
      }),
    ).rejects.toThrow(/at least one sync mutation/u);
    expect((await db.select().from(ProjectTable))[0]?.name).toBe('Before');

    await run(PROJECT_ID, 'project.seed-generation', async ({ changes }) => {
      appendAuthoredDomainMutation(changes, {
        entityType: 'project',
        mutationType: 'update',
        entityId: PROJECT_ID,
        projectId: PROJECT_ID,
        payload: { name: 'Before' },
      });
    });
    await run(PROJECT_ID, 'project.purge', async ({ tx, changes, generation }) => {
      expect(generation?.syncGenerationId).toBe('sync-generation-authored');
      await tx.delete(ProjectTable).where(eq(ProjectTable.id, PROJECT_ID));
      changes.add({
        action: 'sync-generation.purge',
        target: {
          family: 'sync-generation',
          kind: 'sync-generation',
          id: generation!.syncGenerationId,
          incarnation: generation!.generationNumber,
        },
        payload: {},
      });
    });

    expect(await db.select().from(ProjectTable)).toEqual([]);
    expect(await db.select().from(SyncGenerationTable)).toMatchObject([
      { syncGenerationId: 'sync-generation-authored', projectId: null, status: 'active' },
    ]);
    expect(await db.select().from(SyncChangeSetTable)).toHaveLength(2);
    expect(
      (await db.select().from(SyncMutationTable)).some(
        (mutation) => mutation.action === 'sync-generation.purge' && mutation.targetId === 'sync-generation-authored',
      ),
    ).toBe(true);
  });

  it('journals storyline membership as observed-remove plus an independent primary register', async () => {
    const db = await createDatabase();
    const run = runner(db);
    await db.insert(BookNodeTable).values({
      id: 'chapter-membership',
      projectId: PROJECT_ID,
      title: 'Chapter',
      kind: 'chapter',
      writingStatus: 'draft',
      positionX: 0,
      positionY: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(StorylineTable).values({
      id: 'storyline-membership',
      projectId: PROJECT_ID,
      name: 'Storyline',
      color: '#000000',
      orderKey: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await run(PROJECT_ID, 'membership.add', async ({ tx, changes }) => {
      await tx.insert(NodeStorylineLinkTable).values({
        nodeId: 'chapter-membership',
        storylineId: 'storyline-membership',
        isPrimary: true,
      });
      await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, {
        projectId: PROJECT_ID,
        nodeId: 'chapter-membership',
      });
    });
    const liveTag = (await db.select().from(SyncSetTagTable))[0];
    expect(liveTag).toMatchObject({
      ownerKind: 'membership',
      ownerId: 'storyline-membership',
      valueKey: 'chapter-membership',
      removedByChangeSetId: null,
    });
    expect(await db.select().from(SyncFieldClockTable).where(and(
      eq(SyncFieldClockTable.targetKind, 'node-storyline-primary'),
      eq(SyncFieldClockTable.targetId, 'chapter-membership'),
    ))).toHaveLength(1);

    await run(PROJECT_ID, 'membership.clear-primary', async ({ tx, changes }) => {
      await tx.update(NodeStorylineLinkTable).set({ isPrimary: false }).where(and(
        eq(NodeStorylineLinkTable.nodeId, 'chapter-membership'),
        eq(NodeStorylineLinkTable.storylineId, 'storyline-membership'),
      ));
      await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, {
        projectId: PROJECT_ID,
        nodeId: 'chapter-membership',
      });
    });
    expect(await db.select().from(SyncSetTagTable)).toMatchObject([{
      addTag: liveTag!.addTag,
      removedByChangeSetId: null,
    }]);

    await run(PROJECT_ID, 'membership.remove', async ({ tx, changes }) => {
      await tx.delete(NodeStorylineLinkTable).where(and(
        eq(NodeStorylineLinkTable.nodeId, 'chapter-membership'),
        eq(NodeStorylineLinkTable.storylineId, 'storyline-membership'),
      ));
      await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, {
        projectId: PROJECT_ID,
        nodeId: 'chapter-membership',
      });
    });
    expect(await db.select().from(SyncSetTagTable)).toMatchObject([{
      addTag: liveTag!.addTag,
      removedByChangeSetId: 'writer-1:epoch-1:3',
    }]);
    expect(await db.select().from(NodeStorylineLinkTable)).toEqual([]);
    expect((await db.select().from(SyncMutationTable)).map(({ action, targetKind }) => ({
      action,
      targetKind,
    }))).toEqual([
      { action: 'set.add', targetKind: 'membership' },
      { action: 'field.set', targetKind: 'node-storyline-primary' },
      { action: 'field.set', targetKind: 'node-storyline-primary' },
      { action: 'set.remove', targetKind: 'membership' },
      { action: 'field.set', targetKind: 'node-storyline-primary' },
    ]);
  });
});
