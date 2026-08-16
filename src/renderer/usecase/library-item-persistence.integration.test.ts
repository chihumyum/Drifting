import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import type { LibraryItem } from '../domain/library-item';
import {
  genericAssociationRelationType,
  genericAssociationRelationTypeId,
} from '../domain/entity-relation-type';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  BookNodeTable,
  EntityRelationTable,
  LibraryItemTable,
  ProjectTable,
  ProjectAssetTable,
} from '../schema/drizzle';
import { createLibraryItemSqliteRepository } from '../sqlite-repo/library-item-repo';
import { createEntityRelationTypeRepository } from '../sqlite-repo/entity-relation-type-repo';
import { deleteLibraryItemInTransaction } from './library-item-deletion';
import type { AtomicSyncWriter } from './sync-helpers';
import { appendAuthoredDomainMutation, SyncChangeBuilder } from '../sync/journal';

const NOW = '2026-08-15T00:00:00.000Z';
const temporaryDirectories: string[] = [];
const openGateways: ProductFileBackedSqliteGateway[] = [];

async function createDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-library-item-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  openGateways.push(gateway);
  return { gateway, db: gateway.client() };
}

async function seedProject(
  db: ReturnType<ProductFileBackedSqliteGateway['client']>,
  projectId: string,
): Promise<void> {
  await db.insert(ProjectTable).values({
    id: projectId,
    name: projectId,
    userId: 'local-user',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await createEntityRelationTypeRepository(projectId, db).create(
    genericAssociationRelationType(projectId, NOW),
  );
}

function textItem(projectId: string, id: string): LibraryItem {
  return {
    id,
    projectId,
    title: id,
    kind: 'text',
    assetId: null,
    externalUrl: null,
    previewImageUrl: null,
    bodyJson: null,
    notesJson: null,
    orderKey: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

afterEach(async () => {
  for (const gateway of openGateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('library item persistence boundaries', () => {
  it('scopes find, update, delete, and create to the repository project', async () => {
    const { db } = await createDatabase();
    await seedProject(db, 'project-a');
    await seedProject(db, 'project-b');
    const repoA = createLibraryItemSqliteRepository('project-a', db);
    const repoB = createLibraryItemSqliteRepository('project-b', db);
    await repoB.create(textItem('project-b', 'library-b'));

    await expect(repoA.findById('library-b')).resolves.toBeNull();
    await expect(
      repoA.update('library-b', { title: 'wrong project', updatedAt: NOW }),
    ).resolves.toBeNull();
    await expect(repoA.delete('library-b')).resolves.toBe(false);
    await expect(repoA.create(textItem('project-b', 'wrong-create'))).rejects.toThrow(
      'Cannot create a library item for project project-b in project-a',
    );
    await expect(repoB.findById('library-b')).resolves.toMatchObject({ title: 'library-b' });
  });

  it('deletes the owner and every curated relation in one transaction', async () => {
    const { db } = await createDatabase();
    await seedProject(db, 'project-a');
    await db.insert(BookNodeTable).values({
      id: 'node-a',
      title: 'Node A',
      projectId: 'project-a',
      positionX: 0,
      positionY: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const item = textItem('project-a', 'library-a');
    await createLibraryItemSqliteRepository('project-a', db).create(item);
    await db.insert(EntityRelationTable).values({
      id: 'relation-a',
      projectId: 'project-a',
      fromKind: 'library_item',
      fromId: item.id,
      toKind: 'node',
      toId: 'node-a',
      relationTypeId: genericAssociationRelationTypeId('project-a'),
      createdAt: NOW,
      updatedAt: NOW,
    });
    const sync = vi.fn().mockResolvedValue(undefined) as unknown as AtomicSyncWriter;
    const changes = new SyncChangeBuilder();

    const receipt = await db.transaction((tx) =>
      deleteLibraryItemInTransaction(tx, sync, changes, 'project-a', item),
    );

    expect(receipt.relationIds).toEqual(['relation-a']);
    expect(await db.select().from(LibraryItemTable)).toEqual([]);
    expect(await db.select().from(EntityRelationTable)).toEqual([]);
    expect(sync).toHaveBeenNthCalledWith(
      1,
      'entityRelation',
      'delete',
      'relation-a',
      'project-a',
    );
    expect(sync).toHaveBeenNthCalledWith(
      2,
      'libraryItem',
      'delete',
      'library-a',
      'project-a',
    );
  });

  it('rolls back the relation delete when the owner deletion transaction fails', async () => {
    const { db } = await createDatabase();
    await seedProject(db, 'project-a');
    const item = textItem('project-a', 'library-a');
    await createLibraryItemSqliteRepository('project-a', db).create(item);
    await db.insert(EntityRelationTable).values({
      id: 'relation-a',
      projectId: 'project-a',
      fromKind: 'library_item',
      fromId: item.id,
      toKind: 'node',
      toId: 'missing-node-is-valid-for-polymorphic-relation',
      relationTypeId: genericAssociationRelationTypeId('project-a'),
      createdAt: NOW,
      updatedAt: NOW,
    });
    const sync = vi.fn(async (entityType: string) => {
      if (entityType === 'libraryItem') throw new Error('injected outbox failure');
    }) as unknown as AtomicSyncWriter;
    const changes = new SyncChangeBuilder();

    await expect(
      db.transaction((tx) =>
        deleteLibraryItemInTransaction(tx, sync, changes, 'project-a', item),
      ),
    ).rejects.toThrow('injected outbox failure');

    expect(
      await db.select().from(LibraryItemTable).where(eq(LibraryItemTable.id, item.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(EntityRelationTable).where(eq(EntityRelationTable.id, 'relation-a')),
    ).toHaveLength(1);
  });

  it('deletes binary metadata and journals owner unbind plus entity purge', async () => {
    const { db } = await createDatabase();
    await seedProject(db, 'project-a');
    await db.insert(ProjectAssetTable).values({
      id: 'asset-a',
      projectId: 'project-a',
      kind: 'image',
      sourceMime: 'image/png',
      sourceSizeBytes: 3,
      sourceSha256: 'a'.repeat(64),
      width: 10,
      height: 20,
      createdAt: NOW,
    });
    const item: LibraryItem = {
      id: 'library-a',
      projectId: 'project-a',
      title: 'library-a',
      kind: 'image',
      assetId: 'asset-a',
      externalUrl: null,
      previewImageUrl: null,
      bodyJson: null,
      notesJson: null,
      orderKey: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await createLibraryItemSqliteRepository('project-a', db).create(item);
    const changes = new SyncChangeBuilder();
    const sync: AtomicSyncWriter = async (
      entityType,
      mutationType,
      entityId,
      projectId,
      payload,
      parentId,
    ) => {
      appendAuthoredDomainMutation(changes, {
        entityType,
        mutationType,
        entityId,
        projectId,
        payload,
        parentId,
      });
    };

    await db.transaction((tx) =>
      deleteLibraryItemInTransaction(tx, sync, changes, 'project-a', item),
    );

    expect(await db.select().from(LibraryItemTable)).toEqual([]);
    expect(await db.select().from(ProjectAssetTable)).toEqual([]);
    expect(
      (await changes.finalize()).mutations.map(({ mutation }) => ({
        action: mutation.action,
        target: mutation.target,
      })),
    ).toEqual([
      {
        action: 'asset.unbind',
        target: {
          family: 'asset',
          kind: 'project-asset',
          id: 'asset-a',
          incarnation: 0,
        },
      },
      {
        action: 'entity.purge',
        target: {
          family: 'entity',
          kind: 'library-item',
          id: 'library-a',
          incarnation: 0,
        },
      },
    ]);
  });
});
