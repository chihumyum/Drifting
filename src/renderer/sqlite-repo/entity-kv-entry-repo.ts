import { and, eq } from 'drizzle-orm';

import type { EntityKvEntry, EntityKvOwner } from '../domain/entity-kv-entry';
import { assertEntityKvOwner } from '../domain/entity-kv-entry';
import { getDb, type DbExecutor } from '../lib/db';
import { EntityKvEntryTable } from '../schema/drizzle';

export interface EntityKvEntryRepository {
  list(owner: EntityKvOwner): Promise<EntityKvEntry[]>;
  create(entry: EntityKvEntry): Promise<void>;
  update(id: string, values: { key: string; value: string }): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createEntityKvEntryRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): EntityKvEntryRepository {
  if (!projectId) throw new TypeError('entity KV repository requires projectId');
  const db = () => dbOverride ?? getDb();

  return {
    async list(owner) {
      assertEntityKvOwner(owner);
      if (owner.projectId !== projectId) {
        throw new Error(`KV owner project ${owner.projectId} does not match ${projectId}`);
      }
      return db()
        .select()
        .from(EntityKvEntryTable)
        .where(
          and(
            eq(EntityKvEntryTable.projectId, projectId),
            eq(EntityKvEntryTable.ownerKind, owner.ownerKind),
            eq(EntityKvEntryTable.ownerId, owner.ownerId),
            eq(EntityKvEntryTable.namespace, owner.namespace),
          ),
        ) as Promise<EntityKvEntry[]>;
    },
    async create(entry) {
      assertEntityKvOwner(entry);
      if (entry.projectId !== projectId) {
        throw new Error(`KV entry project ${entry.projectId} does not match ${projectId}`);
      }
      await db().insert(EntityKvEntryTable).values(entry);
    },
    async update(id, values) {
      const rows = await db()
        .update(EntityKvEntryTable)
        .set(values)
        .where(and(eq(EntityKvEntryTable.id, id), eq(EntityKvEntryTable.projectId, projectId)))
        .returning({ id: EntityKvEntryTable.id });
      if (rows.length !== 1) throw new Error(`KV entry ${id} not found in project ${projectId}`);
    },
    async remove(id) {
      const rows = await db()
        .delete(EntityKvEntryTable)
        .where(and(eq(EntityKvEntryTable.id, id), eq(EntityKvEntryTable.projectId, projectId)))
        .returning({ id: EntityKvEntryTable.id });
      if (rows.length !== 1) throw new Error(`KV entry ${id} not found in project ${projectId}`);
    },
  };
}
