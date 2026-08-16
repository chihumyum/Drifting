import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient, DbTransaction } from '../lib/db';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  NodeContentTable,
  NodeStorylineLinkTable,
  ProjectAssetTable,
  ProjectTable,
  StorylineTable,
  SyncEntityLifecycleTable,
  SyncSetTagTable,
  SyncGenerationTable,
  YjsDocumentRevisionProvenanceTable,
  YjsDocumentRevisionTable,
  yjsUpdates,
} from '../schema/drizzle';
import {
  appendProjectAssetBindMutation,
  readAuthoredOrderEntriesInTransaction,
  recordAuthoredChangeSetInTransaction,
  SyncChangeBuilder,
  type SyncWriterIdentitySource,
} from '../sync/journal';
import type { CanonicalCborValue, SyncChangeSetV1 } from '../sync/protocol';
import {
  invalidateSqliteReducerStateCache,
  observeLocalAuthoredReducerInTransaction,
} from '../sync/reducer/sqlite-materializer';
import { appendAuthoredLifecycleRestoreInTransaction } from './sync-lifecycle-restore';

const PROJECT_ID = 'project-lifecycle-restore';
const SYNC_GENERATION_ID = 'sync-generation-lifecycle-restore';
const PROJECT_SYNC_ID = 'project-sync-lifecycle-restore';
const NODE_ID = 'node-restore';
const STORYLINE_ID = 'storyline-restore';
const MEMBERSHIP_STORYLINE_ID = 'storyline-membership-live';
const ELEMENT_ID = 'element-restore';
const CATEGORY_ID = 'category-restore';
const ASSET_ID = 'asset-restore';
const NOW = '2026-08-15T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

const identity: SyncWriterIdentitySource = {
  installationId: 'restore-installation',
  createWriterIdentity: () => ({
    writerId: 'restore-writer',
    writerEpoch: 'restore-epoch',
  }),
};

async function createDatabase(): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-lifecycle-restore-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: 'local-user',
    name: 'Restore project',
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
  await db.insert(StorylineTable).values([
    {
      id: STORYLINE_ID,
      projectId: PROJECT_ID,
      name: 'Restorable storyline',
      color: '#112233',
      summary: 'storyline summary',
      orderKey: 7,
      contentJson: JSON.stringify({ type: 'doc', content: [] }),
      nodeContentTemplateJson: '{}',
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: MEMBERSHIP_STORYLINE_ID,
      projectId: PROJECT_ID,
      name: 'Live membership storyline',
      color: '#445566',
      orderKey: 8,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  await db.insert(BookNodeTable).values({
    id: NODE_ID,
    projectId: PROJECT_ID,
    title: 'Restorable chapter',
    summary: 'node summary',
    bookOrder: 4,
    narrativeOrder: 12,
    writingStatus: 'draft',
    kind: 'chapter',
    driftGroupId: null,
    positionX: 3,
    positionY: 9,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(NodeContentTable).values({
    nodeId: NODE_ID,
    contentJson: JSON.stringify({ type: 'doc', content: [] }),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(NodeStorylineLinkTable).values({
    nodeId: NODE_ID,
    storylineId: MEMBERSHIP_STORYLINE_ID,
    isPrimary: true,
  });
  await db.insert(ElementCategoryTable).values({
    id: CATEGORY_ID,
    projectId: PROJECT_ID,
    name: 'Restorable category',
    contentJson: JSON.stringify({ type: 'doc', content: [] }),
    elementTemplateJson: '{}',
    color: '#778899',
    layoutMode: 'pinned',
    gridX: 2,
    gridY: 5,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(ProjectAssetTable).values({
    id: ASSET_ID,
    projectId: PROJECT_ID,
    kind: 'image',
    sourceMime: 'image/png',
    sourceSizeBytes: 1,
    sourceSha256: SHA,
    width: 1,
    height: 1,
    createdAt: NOW,
  });
  await db.insert(BookElementTable).values({
    id: ELEMENT_ID,
    projectId: PROJECT_ID,
    categoryId: CATEGORY_ID,
    name: 'Restorable element',
    summary: 'element summary',
    contentJson: JSON.stringify({ type: 'doc', content: [] }),
    aliasesJson: JSON.stringify(['Alias']),
    groupName: 'group',
    portraitAssetId: ASSET_ID,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return db;
}

async function record(
  tx: DbTransaction,
  changes: SyncChangeBuilder,
  nowMs: number,
): Promise<SyncChangeSetV1> {
  const clock = { nowMs, nowIso: new Date(nowMs).toISOString() };
  const recorded = await recordAuthoredChangeSetInTransaction(
    tx,
    {
      projectId: PROJECT_ID,
      projectSyncId: PROJECT_SYNC_ID,
      syncGenerationId: SYNC_GENERATION_ID,
      identity,
      clock,
    },
    changes,
  );
  await observeLocalAuthoredReducerInTransaction(tx, {
    changeSet: recorded.changeSet,
    clock,
  });
  return recorded.changeSet;
}

function addLifecycleSeed(
  changes: SyncChangeBuilder,
  kind: string,
  id: string,
  seed: Record<string, CanonicalCborValue>,
): void {
  changes.add({
    action: 'entity.create',
    target: { family: 'entity', kind, id, incarnation: 0 },
    payload: { seed },
  });
}

afterEach(async () => {
  invalidateSqliteReducerStateCache();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('authored lifecycle restore', () => {
  it('emits n+1 full seeds/Yjs and explicit owner authorities for all four Trash paths', async () => {
    const db = await createDatabase();
    await db.transaction(async (tx) => {
      const changes = new SyncChangeBuilder();
      addLifecycleSeed(changes, 'node', NODE_ID, { title: 'Restorable chapter', kind: 'chapter' });
      addLifecycleSeed(changes, 'storyline', STORYLINE_ID, { name: 'Restorable storyline', color: '#112233' });
      addLifecycleSeed(changes, 'storyline', MEMBERSHIP_STORYLINE_ID, { name: 'Live membership storyline', color: '#445566' });
      addLifecycleSeed(changes, 'element', ELEMENT_ID, { name: 'Restorable element' });
      addLifecycleSeed(changes, 'element-category', CATEGORY_ID, { name: 'Restorable category', color: '#778899' });
      changes.add({
        action: 'set.add',
        target: { family: 'set', kind: 'membership', id: MEMBERSHIP_STORYLINE_ID, incarnation: 0 },
        payload: { memberId: NODE_ID, value: null },
      });
      changes.add({
        action: 'field.set',
        target: { family: 'entity', kind: 'node-storyline-primary', id: NODE_ID, incarnation: 0 },
        payload: { field: 'storylineId', value: MEMBERSHIP_STORYLINE_ID },
      });
      appendProjectAssetBindMutation(
        changes,
        PROJECT_ID,
        {
          id: ASSET_ID,
          projectId: PROJECT_ID,
          kind: 'image',
          sourceMime: 'image/png',
          sourceSizeBytes: 1,
          sourceSha256: SHA,
          width: 1,
          height: 1,
          createdAt: NOW,
        },
        { kind: 'element-portrait', id: ELEMENT_ID },
      );
      await record(tx, changes, 1);
    });

    await db.transaction(async (tx) => {
      await Promise.all([
        tx.update(BookNodeTable).set({ deletedAt: NOW }).where(eq(BookNodeTable.id, NODE_ID)),
        tx.update(StorylineTable).set({ deletedAt: NOW }).where(eq(StorylineTable.id, STORYLINE_ID)),
        tx.update(BookElementTable).set({ deletedAt: NOW }).where(eq(BookElementTable.id, ELEMENT_ID)),
        tx.update(ElementCategoryTable).set({ deletedAt: NOW }).where(eq(ElementCategoryTable.id, CATEGORY_ID)),
      ]);
      const changes = new SyncChangeBuilder();
      for (const [kind, id] of [
        ['node', NODE_ID],
        ['storyline', STORYLINE_ID],
        ['element', ELEMENT_ID],
        ['element-category', CATEGORY_ID],
      ] as const) {
        changes.add({
          action: 'entity.trash',
          target: { family: 'entity', kind, id, incarnation: 0 },
          payload: {},
        });
      }
      await record(tx, changes, 2);
    });

    const restore = async (
      entityType: 'node' | 'storyline' | 'element' | 'elementCategory',
      entityId: string,
      table: typeof BookNodeTable | typeof StorylineTable | typeof BookElementTable | typeof ElementCategoryTable,
      idColumn: typeof BookNodeTable.id | typeof StorylineTable.id | typeof BookElementTable.id | typeof ElementCategoryTable.id,
      nowMs: number,
    ) => db.transaction(async (tx) => {
      await tx.update(table as never).set({ deletedAt: null }).where(eq(idColumn, entityId));
      const changes = new SyncChangeBuilder();
      await appendAuthoredLifecycleRestoreInTransaction(tx, changes, {
        projectId: PROJECT_ID,
        entityType,
        entityId,
      });
      return record(tx, changes, nowMs);
    });

    const node = await restore('node', NODE_ID, BookNodeTable, BookNodeTable.id, 3);
    const storyline = await restore(
      'storyline',
      STORYLINE_ID,
      StorylineTable,
      StorylineTable.id,
      4,
    );
    const element = await restore('element', ELEMENT_ID, BookElementTable, BookElementTable.id, 5);
    const category = await restore(
      'elementCategory',
      CATEGORY_ID,
      ElementCategoryTable,
      ElementCategoryTable.id,
      6,
    );

    for (const changeSet of [node, storyline, element, category]) {
      const lifecycle = changeSet.mutations.find((mutation) => mutation.action === 'entity.restore');
      const yjs = changeSet.mutations.find((mutation) => mutation.action === 'yjs.update');
      expect(lifecycle?.target.incarnation).toBe(1);
      expect(lifecycle?.payload).toMatchObject({ seed: expect.any(Object) });
      expect(JSON.stringify(lifecycle?.payload)).not.toContain('contentJson');
      expect(yjs?.target.incarnation).toBe(1);
      expect(yjs?.payload).toMatchObject({ update: expect.any(Uint8Array) });
    }

    expect(
      (await db.select().from(yjsUpdates)).map(({ docId }) => docId).sort(),
    ).toEqual([
      `category:${CATEGORY_ID}`,
      `element:${ELEMENT_ID}`,
      `node-content:${NODE_ID}`,
      `storyline:${STORYLINE_ID}`,
    ]);
    expect(
      (await db.select().from(YjsDocumentRevisionTable)).map(({ docId, revision }) => ({
        docId,
        revision,
      })),
    ).toEqual(expect.arrayContaining([
      { docId: `node-content:${NODE_ID}`, revision: 1 },
      { docId: `storyline:${STORYLINE_ID}`, revision: 1 },
      { docId: `element:${ELEMENT_ID}`, revision: 1 },
      { docId: `category:${CATEGORY_ID}`, revision: 1 },
    ]));
    expect(
      (await db.select().from(YjsDocumentRevisionProvenanceTable)).map(
        ({ docId, sourceKind }) => ({ docId, sourceKind }),
      ),
    ).toEqual(expect.arrayContaining([
      { docId: `node-content:${NODE_ID}`, sourceKind: 'system' },
      { docId: `storyline:${STORYLINE_ID}`, sourceKind: 'system' },
      { docId: `element:${ELEMENT_ID}`, sourceKind: 'system' },
      { docId: `category:${CATEGORY_ID}`, sourceKind: 'system' },
    ]));

    expect(node.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'tuple.set',
        target: expect.objectContaining({ kind: 'node', incarnation: 1 }),
      }),
      expect.objectContaining({
        action: 'order.move',
        target: expect.objectContaining({ kind: 'chapter', incarnation: 1 }),
      }),
      expect.objectContaining({
        action: 'set.remove',
        target: expect.objectContaining({ kind: 'membership', incarnation: 0 }),
      }),
      expect.objectContaining({
        action: 'set.add',
        target: expect.objectContaining({ kind: 'membership', incarnation: 0 }),
      }),
      expect.objectContaining({
        action: 'field.set',
        target: expect.objectContaining({ kind: 'node-storyline-primary', incarnation: 1 }),
      }),
    ]));
    expect(storyline.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'order.move',
        target: expect.objectContaining({ kind: 'storyline', incarnation: 1 }),
      }),
    ]));
    expect(element.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'set.add',
        target: expect.objectContaining({ kind: 'alias', incarnation: 1 }),
      }),
      expect.objectContaining({
        action: 'asset.bind',
        target: expect.objectContaining({ kind: 'project-asset', incarnation: 1 }),
      }),
    ]));
    expect(category.mutations.find((mutation) => mutation.action === 'entity.restore')?.payload)
      .toMatchObject({
        seed: {
          name: 'Restorable category',
          layoutMode: 'pinned',
          gridX: 2,
          gridY: 5,
        },
      });

    expect(await db.select({
      kind: SyncEntityLifecycleTable.entityKind,
      incarnation: SyncEntityLifecycleTable.incarnation,
      state: SyncEntityLifecycleTable.state,
    }).from(SyncEntityLifecycleTable).where(and(
      eq(SyncEntityLifecycleTable.syncGenerationId, SYNC_GENERATION_ID),
      eq(SyncEntityLifecycleTable.incarnation, 1),
    ))).toEqual(expect.arrayContaining([
      { kind: 'node', incarnation: 1, state: 'live' },
      { kind: 'storyline', incarnation: 1, state: 'live' },
      { kind: 'element', incarnation: 1, state: 'live' },
      { kind: 'element-category', incarnation: 1, state: 'live' },
    ]));
    const membershipTags = await db.select().from(SyncSetTagTable).where(and(
      eq(SyncSetTagTable.ownerId, MEMBERSHIP_STORYLINE_ID),
      eq(SyncSetTagTable.valueKey, NODE_ID),
    ));
    expect(membershipTags).toHaveLength(2);
    expect(membershipTags.filter((tag) => tag.removedByChangeSetId === null)).toHaveLength(1);
    expect(
      await readAuthoredOrderEntriesInTransaction(db, {
        projectId: PROJECT_ID,
        listKind: 'chapter',
        scope: PROJECT_ID,
      }),
    ).toMatchObject([{ entityId: NODE_ID }]);
  });
});
