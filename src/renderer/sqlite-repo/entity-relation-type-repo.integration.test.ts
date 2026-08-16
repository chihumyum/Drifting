import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import {
  genericAssociationRelationType,
  genericAssociationRelationTypeId,
} from '../domain/entity-relation-type';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  EntityRelationTable,
  EntityRelationTypeEndpointKindTable,
  EntityRelationTypeTable,
  ProjectTable,
} from '../schema/drizzle';
import { createEntityRelationTypeRepository } from './entity-relation-type-repo';

const NOW = '2026-08-15T00:00:00.000Z';
const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

async function createDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-relation-type-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  return gateway.client();
}

async function seedProject(
  db: ReturnType<ProductFileBackedSqliteGateway['client']>,
  projectId: string,
): Promise<void> {
  await db.insert(ProjectTable).values({
    id: projectId,
    userId: 'local-user',
    name: projectId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await createEntityRelationTypeRepository(projectId, db).create(
    genericAssociationRelationType(projectId, NOW),
  );
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('entity relation type database invariants', () => {
  it('enforces same-project ownership and persistent semantic deduplication', async () => {
    const db = await createDatabase();
    await seedProject(db, 'project-a');
    await seedProject(db, 'project-b');

    await expect(
      db.insert(EntityRelationTable).values({
        id: 'cross-project',
        projectId: 'project-a',
        fromKind: 'comment',
        fromId: 'comment-a',
        toKind: 'node',
        toId: 'node-a',
        relationTypeId: genericAssociationRelationTypeId('project-b'),
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toThrow();

    const relation = {
      id: 'relation-a',
      projectId: 'project-a',
      fromKind: 'comment',
      fromId: 'comment-a',
      toKind: 'node',
      toId: 'node-a',
      relationTypeId: genericAssociationRelationTypeId('project-a'),
      createdAt: NOW,
      updatedAt: NOW,
    } as const;
    await db.insert(EntityRelationTable).values(relation);
    await expect(
      db.insert(EntityRelationTable).values({ ...relation, id: 'relation-duplicate' }),
    ).rejects.toThrow();
  });

  it('protects locked fields and endpoints but permits project cascade deletion', async () => {
    const db = await createDatabase();
    await seedProject(db, 'project-a');
    const relationTypeId = genericAssociationRelationTypeId('project-a');

    await expect(
      db
        .update(EntityRelationTypeTable)
        .set({ name: 'Renamed' })
        .where(eq(EntityRelationTypeTable.id, relationTypeId)),
    ).rejects.toThrow();
    await expect(
      db
        .delete(EntityRelationTypeEndpointKindTable)
        .where(
          and(
            eq(EntityRelationTypeEndpointKindTable.relationTypeId, relationTypeId),
            eq(EntityRelationTypeEndpointKindTable.side, 'source'),
            eq(EntityRelationTypeEndpointKindTable.entityKind, 'comment'),
          ),
        ),
    ).rejects.toThrow();
    await expect(
      db.insert(EntityRelationTypeEndpointKindTable).values({
        relationTypeId,
        side: 'source',
        entityKind: 'node',
      }),
    ).rejects.toThrow();
    await expect(
      db.delete(EntityRelationTypeTable).where(eq(EntityRelationTypeTable.id, relationTypeId)),
    ).rejects.toThrow();

    await db.insert(EntityRelationTable).values({
      id: 'relation-a',
      projectId: 'project-a',
      fromKind: 'comment',
      fromId: 'comment-a',
      toKind: 'node',
      toId: 'node-a',
      relationTypeId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.delete(ProjectTable).where(eq(ProjectTable.id, 'project-a'));
    expect(
      await db
        .select()
        .from(EntityRelationTable)
        .where(eq(EntityRelationTable.projectId, 'project-a')),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(EntityRelationTypeTable)
        .where(eq(EntityRelationTypeTable.id, relationTypeId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(EntityRelationTypeEndpointKindTable)
        .where(eq(EntityRelationTypeEndpointKindTable.relationTypeId, relationTypeId)),
    ).toEqual([]);
  });
});
