import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../lib/db';
import {
  BookNodeTable,
  NodeContentTable,
  NodeStorylineLinkTable,
  ProjectTable,
  StorylineTable,
  SyncChangeSetTable,
  SyncEntityLifecycleTable,
  SyncMutationTable,
  SyncSetTagTable,
} from '../schema/drizzle';
import { createEntitySeedUpdate } from '../hooks/useEntityYjsDoc';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import { appendAuthoredNodeStorylineProjectionInTransaction } from '../sync/journal/storyline-membership';
import { appendAuthoredProseSeedInTransaction } from '../sync/journal/yjs-update';
import { purgeTrashedNode } from './book-node-purge';
import { withAtomicSyncTransaction } from './sync-helpers';

const databaseSlot = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db')>();
  return { ...actual, getDb: () => databaseSlot.current as ReturnType<typeof actual.getDb> };
});
vi.mock('../sync/journal/installation-identity', () => ({
  getSyncInstallationIdentity: async () => ({
    installationId: 'synthetic-purge-install',
    createWriterIdentity: () => ({ writerId: 'synthetic-purge-writer', writerEpoch: 'synthetic-purge-epoch' }),
  }),
}));

const PROJECT_ID = 'project-purge';
const CHAPTER_ID = 'chapter-purge';
const STORYLINE_ID = 'storyline-purge';
const NOW = '2026-11-04T00:00:00.000Z';
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

afterEach(async () => {
  databaseSlot.current = null;
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A chapter whose primary storyline is a live storyline, then moved to the trash. */
async function trashedChapterInStoryline(): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-node-purge-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  databaseSlot.current = db;
  await db.insert(ProjectTable).values({ id: PROJECT_ID, userId: 'local-user', name: 'Purge', createdAt: NOW, updatedAt: NOW });

  const seed = await createEntitySeedUpdate(JSON.stringify({ type: 'doc', content: [] }));
  await withAtomicSyncTransaction(PROJECT_ID, async (tx, sync, changes) => {
    await tx.insert(StorylineTable).values({
      id: STORYLINE_ID, projectId: PROJECT_ID, name: '主线', color: '#000000', orderKey: 0,
      createdAt: NOW, updatedAt: NOW,
    });
    await sync('storyline', 'create', STORYLINE_ID, PROJECT_ID, {
      id: STORYLINE_ID, name: '主线', color: '#000000', summary: '', nodeContentTemplateJson: '{}',
    });
    await appendAuthoredProseSeedInTransaction(tx, changes, { entityType: 'storyline', entityId: STORYLINE_ID, stateUpdate: seed });
    await tx.insert(BookNodeTable).values({
      id: CHAPTER_ID, projectId: PROJECT_ID, title: '雨夜', summary: '', kind: 'chapter',
      writingStatus: 'draft', bookOrder: 1, positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW,
    });
    await tx.insert(NodeContentTable).values({ nodeId: CHAPTER_ID, contentJson: '{}', createdAt: NOW, updatedAt: NOW });
    await sync('node', 'create', CHAPTER_ID, PROJECT_ID, {
      id: CHAPTER_ID, title: '雨夜', summary: '', bookOrder: 1, narrativeOrder: null, kind: 'chapter',
      driftGroupId: null, positionX: 0, positionY: 0, writingStatus: 'draft',
    });
    await appendAuthoredProseSeedInTransaction(tx, changes, { entityType: 'node', entityId: CHAPTER_ID, stateUpdate: seed });
    await tx.insert(NodeStorylineLinkTable).values({ nodeId: CHAPTER_ID, storylineId: STORYLINE_ID, isPrimary: true });
    await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, { projectId: PROJECT_ID, nodeId: CHAPTER_ID });
  });

  await withAtomicSyncTransaction(PROJECT_ID, async (tx, sync) => {
    await createBookNodeSqliteRepository(PROJECT_ID, tx).softDelete(CHAPTER_ID);
    await sync('node', 'softDelete', CHAPTER_ID, PROJECT_ID);
  });
  return db;
}

describe('purgeTrashedNode', () => {
  it('deletes a trashed chapter that still belongs to a storyline for good', async () => {
    const db = await trashedChapterInStoryline();

    await purgeTrashedNode(PROJECT_ID, CHAPTER_ID);

    expect(await db.select().from(BookNodeTable).where(eq(BookNodeTable.id, CHAPTER_ID))).toEqual([]);
    expect(await db.select().from(NodeContentTable).where(eq(NodeContentTable.nodeId, CHAPTER_ID))).toEqual([]);
    expect(await db.select().from(NodeStorylineLinkTable)).toEqual([]);
    const [tag] = await db.select().from(SyncSetTagTable).where(eq(SyncSetTagTable.valueKey, CHAPTER_ID));
    expect(tag?.removedByChangeSetId).not.toBeNull();
    expect(
      (await db.select().from(SyncEntityLifecycleTable).where(eq(SyncEntityLifecycleTable.entityId, CHAPTER_ID)))
        .map(({ entityKind, state }) => ({ entityKind, state })),
    ).toEqual([{ entityKind: 'node', state: 'purged' }]);

    // The purge change-set leaves the storyline and ends the node; the
    // chapter-owned primary-storyline register is not written.
    const changeSets = await db.select().from(SyncChangeSetTable);
    const purgeChangeSet = changeSets.find(({ changeSetId }) => changeSetId === tag?.removedByChangeSetId);
    const purgeMutations = (await db.select().from(SyncMutationTable))
      .filter(({ changeSetId }) => changeSetId === purgeChangeSet?.changeSetId)
      .map(({ action, targetKind }) => ({ action, targetKind }));
    expect(purgeMutations).toEqual([
      { action: 'set.remove', targetKind: 'membership' },
      { action: 'entity.purge', targetKind: 'node' },
    ]);
  });
});
