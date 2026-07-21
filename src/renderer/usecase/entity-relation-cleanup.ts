import { and, eq, or } from 'drizzle-orm';
import type { StructuralEntityKind } from '../domain/entity-kinds';
import type { DbTransaction } from '../lib/db';
import { EntityRelationTable } from '../schema/drizzle';
import type { AtomicSyncWriter } from './sync-helpers';

interface RelationEndpoints {
  projectId: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
}

function relationBelongsToEntity(
  relation: RelationEndpoints,
  projectId: string,
  kind: StructuralEntityKind,
  id: string,
): boolean {
  return (
    relation.projectId === projectId &&
    ((relation.fromKind === kind && relation.fromId === id) ||
      (relation.toKind === kind && relation.toId === id))
  );
}

export function withoutRelationsForEntity<T extends RelationEndpoints>(
  relations: T[],
  projectId: string,
  kind: StructuralEntityKind,
  id: string,
): T[] {
  return relations.filter((relation) => !relationBelongsToEntity(relation, projectId, kind, id));
}

/**
 * Permanently remove every curated relation touching an entity and enqueue
 * the matching remote deletes through the caller's transaction-bound writer.
 * This is intentionally used for soft-delete too: trash restore does not
 * resurrect relationships on either client or server.
 */
export async function deleteEntityRelationsInTransaction(
  tx: DbTransaction,
  sync: AtomicSyncWriter,
  projectId: string,
  kind: StructuralEntityKind,
  id: string,
): Promise<string[]> {
  const condition = and(
    eq(EntityRelationTable.projectId, projectId),
    or(
      and(eq(EntityRelationTable.fromKind, kind), eq(EntityRelationTable.fromId, id)),
      and(eq(EntityRelationTable.toKind, kind), eq(EntityRelationTable.toId, id)),
    ),
  );
  const rows = await tx
    .select({ id: EntityRelationTable.id })
    .from(EntityRelationTable)
    .where(condition);
  if (rows.length === 0) return [];

  await tx.delete(EntityRelationTable).where(condition);
  for (const relation of rows) {
    await sync('entityRelation', 'delete', relation.id, projectId);
  }
  return rows.map((relation) => relation.id);
}
