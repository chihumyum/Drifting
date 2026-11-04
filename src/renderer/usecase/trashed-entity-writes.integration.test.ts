import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { deriveProseMetricFromJson } from '@drifting/prose-metrics';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createYjsProseSeedState } from '../lib/agent/runtime/yjs-prose-command';
import type { DbClient } from '../lib/db';
import {
  BookNodeTable,
  DriftGroupTable,
  NodeStorylineLinkTable,
  ProjectTable,
  StorylineTable,
  SyncChangeSetTable,
  SyncMutationTable,
  SyncSetTagTable,
} from '../schema/drizzle';
import { createBookContentRepository } from '../sqlite-repo/content-repo';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import { createAuthoredTransactionRunner } from '../sync/journal/authored-transaction';
import { appendAuthoredDomainMutation } from '../sync/journal/domain-mutation';
import { appendAuthoredNodeStorylineProjectionInTransaction } from '../sync/journal/storyline-membership';
import { appendAuthoredProseSeedInTransaction } from '../sync/journal/yjs-update';
import { removeStorylineMembershipsInTransaction } from './storyline-membership-removal';
import { appendAuthoredLifecycleRestoreInTransaction } from './sync-lifecycle-restore';

/*
 * Writes that reach a node in the Trash must still pass the local post-write
 * validation: a register or seed that cannot land would otherwise fail the
 * whole command. Deleting a node for good is covered by
 * book-node-purge.integration.test.ts.
 */

const PROJECT_ID = 'project-trashed-writes';
const CHAPTER_ID = 'chapter-trashed-writes';
const DRIFT_ID = 'drift-trashed-writes';
const STORYLINE_ID = 'storyline-trashed-writes';
const GROUP_ID = 'drift-group-trashed-writes';
const NOW = '2026-11-04T12:00:00.000Z';
const EMPTY_DOC = JSON.stringify({ type: 'doc', content: [] });
const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function book() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-trashed-writes-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT_ID, userId: 'local-user', name: 'Book', createdAt: NOW, updatedAt: NOW,
  });
  await db.insert(StorylineTable).values({
    id: STORYLINE_ID, projectId: PROJECT_ID, name: 'Main', color: '#000000', orderKey: 0,
    createdAt: NOW, updatedAt: NOW,
  });
  await db.insert(DriftGroupTable).values({
    id: GROUP_ID, projectId: PROJECT_ID, name: 'Group', parentGroupId: null,
    createdAt: NOW, updatedAt: NOW,
  });
  let writer = 0;
  let clock = 1_000;
  const run = createAuthoredTransactionRunner({
    database: () => db,
    identity: async () => ({
      installationId: 'installation-trashed-writes',
      createWriterIdentity: () => {
        writer += 1;
        return { writerId: `writer-${writer}`, writerEpoch: `epoch-${writer}` };
      },
    }),
    clock: () => ({ nowMs: (clock += 10), nowIso: NOW }),
    syncGenerationIds: {
      createSyncGenerationId: () => 'sync-generation-trashed-writes',
      createProjectSyncId: () => 'projectSync-trashed-writes',
    },
  });

  /** A node authored the way the create command writes one. */
  const create = async (kind: 'chapter' | 'drift') => {
    const id = kind === 'chapter' ? CHAPTER_ID : DRIFT_ID;
    const [metric, seed] = await Promise.all([
      deriveProseMetricFromJson(EMPTY_DOC),
      createYjsProseSeedState(EMPTY_DOC),
    ]);
    const placement = kind === 'chapter'
      ? { kind, bookOrder: 0, driftGroupId: null, writingStatus: 'draft' as const }
      : { kind, bookOrder: null, driftGroupId: GROUP_ID, writingStatus: 'drifting' as const };
    const prose = {
      wordCount: metric.wordCount, wordCountBasisKind: 'yjs' as const,
      wordCountBasisHash: metric.basisHash, wordCountBasisRevision: 1, wordCountBasisServerSeq: null,
    };
    await run(PROJECT_ID, 'domain.authored-write', async ({ tx, changes }) => {
      await createBookNodeSqliteRepository(PROJECT_ID, tx).create({
        id, projectId: PROJECT_ID, title: kind, summary: '', narrativeOrder: null,
        position: { x: 0, y: 0 }, createdAt: NOW, updatedAt: NOW, ...placement, ...prose,
      });
      if (kind === 'chapter') {
        await tx.insert(NodeStorylineLinkTable).values({
          nodeId: id, storylineId: STORYLINE_ID, isPrimary: true,
        });
      }
      await createBookContentRepository(tx).create({ nodeId: id, contentJson: EMPTY_DOC });
      appendAuthoredDomainMutation(changes, {
        entityType: 'node', mutationType: 'create', entityId: id, projectId: PROJECT_ID,
        payload: {
          id, title: kind, summary: '', narrativeOrder: null, positionX: 0, positionY: 0,
          ...placement, ...prose,
        },
      });
      await appendAuthoredProseSeedInTransaction(tx, changes, {
        entityType: 'node', entityId: id, stateUpdate: seed,
      });
      if (kind === 'chapter') {
        await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, {
          projectId: PROJECT_ID, nodeId: id,
        });
      }
    });
    return id;
  };
  const trash = (id: string) => run(PROJECT_ID, 'domain.authored-write', async ({ tx, changes }) => {
    await createBookNodeSqliteRepository(PROJECT_ID, tx).softDelete(id);
    appendAuthoredDomainMutation(changes, {
      entityType: 'node', mutationType: 'softDelete', entityId: id, projectId: PROJECT_ID,
    });
  });
  const restore = (id: string) => run(PROJECT_ID, 'domain.authored-write', async ({ tx, changes }) => {
    await createBookNodeSqliteRepository(PROJECT_ID, tx).restore(id);
    await appendAuthoredLifecycleRestoreInTransaction(tx, changes, {
      projectId: PROJECT_ID, entityType: 'node', entityId: id,
    });
  });
  const leaveStoryline = () => run(PROJECT_ID, 'domain.authored-write', async ({ tx, changes }) => {
    await tx.delete(NodeStorylineLinkTable).where(and(
      eq(NodeStorylineLinkTable.nodeId, CHAPTER_ID),
      eq(NodeStorylineLinkTable.storylineId, STORYLINE_ID),
    ));
    await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, {
      projectId: PROJECT_ID, nodeId: CHAPTER_ID,
    });
  });
  // What deleteStoryline writes for the storyline's chapters.
  const removeStoryline = () => run(PROJECT_ID, 'domain.authored-write', ({ tx, changes }) =>
    removeStorylineMembershipsInTransaction(tx, changes, {
      projectId: PROJECT_ID, storylineId: STORYLINE_ID,
    }));
  // deleteGroup moves only the drifts on the board; the row is what restore sees.
  const deleteGroup = () => db.delete(DriftGroupTable).where(eq(DriftGroupTable.id, GROUP_ID));
  return { db, create, trash, restore, leaveStoryline, removeStoryline, deleteGroup };
}

async function lastChangeSetMutations(db: DbClient) {
  const changeSets = await db
    .select({ changeSetId: SyncChangeSetTable.changeSetId, deviceSeq: SyncChangeSetTable.deviceSeq })
    .from(SyncChangeSetTable);
  const last = changeSets.sort((left, right) => right.deviceSeq - left.deviceSeq)[0]!;
  const mutations = await db.select().from(SyncMutationTable)
    .where(eq(SyncMutationTable.changeSetId, last.changeSetId));
  return mutations
    .sort((left, right) => left.mutationIndex - right.mutationIndex)
    .map(({ action, targetKind }) => ({ action, targetKind }));
}

async function liveMembershipTags(db: DbClient) {
  return (await db.select().from(SyncSetTagTable).where(eq(SyncSetTagTable.valueKey, CHAPTER_ID)))
    .filter((tag) => tag.removedByChangeSetId === null);
}

describe('storyline membership of a chapter in the Trash', () => {
  it('takes a chapter in the Trash off a storyline', async () => {
    const { db, create, trash, leaveStoryline } = await book();
    await trash(await create('chapter'));
    await leaveStoryline();

    expect(await lastChangeSetMutations(db)).toEqual([
      { action: 'set.remove', targetKind: 'membership' },
    ]);
    expect(await liveMembershipTags(db)).toEqual([]);
  });

  it('deletes a storyline whose chapter is in the Trash and journals the removal', async () => {
    const { db, create, trash, removeStoryline } = await book();
    await trash(await create('chapter'));
    expect(await removeStoryline()).toEqual([CHAPTER_ID]);

    expect(await db.select().from(NodeStorylineLinkTable)).toEqual([]);
    expect(await lastChangeSetMutations(db)).toEqual([
      { action: 'set.remove', targetKind: 'membership' },
    ]);
    expect(await liveMembershipTags(db)).toEqual([]);
  });
});

describe('restoring a drift whose group was deleted while it was in the Trash', () => {
  it('brings the drift back at the top level', async () => {
    const { db, create, trash, restore, deleteGroup } = await book();
    await trash(await create('drift'));
    await deleteGroup();
    await restore(DRIFT_ID);

    expect(await db.select({ deletedAt: BookNodeTable.deletedAt, driftGroupId: BookNodeTable.driftGroupId })
      .from(BookNodeTable).where(eq(BookNodeTable.id, DRIFT_ID))).toEqual([
      { deletedAt: null, driftGroupId: null },
    ]);
  });

  it('keeps a group that still exists', async () => {
    const { db, create, trash, restore } = await book();
    await trash(await create('drift'));
    await restore(DRIFT_ID);

    expect(await db.select({ driftGroupId: BookNodeTable.driftGroupId })
      .from(BookNodeTable).where(eq(BookNodeTable.id, DRIFT_ID))).toEqual([
      { driftGroupId: GROUP_ID },
    ]);
  });
});
