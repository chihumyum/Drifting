import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type {
  EntityRelationType,
} from '../domain/entity-relation-type';
import type { EntityRefSourceKind, EntityRefTargetKind } from '../domain/entity-kinds';
import { ALL_ENTITY_KINDS, STRUCTURAL_ENTITY_KINDS } from '../domain/entity-kinds';
import { getDb, type DbExecutor } from '../lib/db';
import {
  EntityRelationTable,
  EntityRelationTypeEndpointKindTable,
  EntityRelationTypeTable,
} from '../schema/drizzle';

type RelationTypeRow = typeof EntityRelationTypeTable.$inferSelect;
type EndpointKindRow = typeof EntityRelationTypeEndpointKindTable.$inferSelect;

export interface EntityRelationTypeRepository {
  list(): Promise<EntityRelationType[]>;
  findById(id: string): Promise<EntityRelationType | null>;
  findByNormalizedName(normalizedName: string): Promise<EntityRelationType | null>;
  create(value: EntityRelationType): Promise<EntityRelationType>;
  update(value: EntityRelationType): Promise<EntityRelationType>;
  remove(id: string): Promise<void>;
  countRelations(id: string): Promise<number>;
}

function endpointRows(value: EntityRelationType): Array<typeof EntityRelationTypeEndpointKindTable.$inferInsert> {
  return [
    ...value.sourceKinds.map((entityKind) => ({
      relationTypeId: value.id,
      side: 'source' as const,
      entityKind,
    })),
    ...value.targetKinds.map((entityKind) => ({
      relationTypeId: value.id,
      side: 'target' as const,
      entityKind,
    })),
  ];
}

function materialize(row: RelationTypeRow, endpoints: readonly EndpointKindRow[]): EntityRelationType {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    normalizedName: row.normalizedName,
    description: row.description,
    orientation: row.orientation as EntityRelationType['orientation'],
    sourceRole: row.sourceRole,
    targetRole: row.targetRole,
    sourceKinds: ALL_ENTITY_KINDS.filter((kind) =>
      endpoints.some(
        (endpoint) =>
          endpoint.relationTypeId === row.id &&
          endpoint.side === 'source' &&
          endpoint.entityKind === kind,
      ),
    ) as EntityRefSourceKind[],
    targetKinds: STRUCTURAL_ENTITY_KINDS.filter((kind) =>
      endpoints.some(
        (endpoint) =>
          endpoint.relationTypeId === row.id &&
          endpoint.side === 'target' &&
          endpoint.entityKind === kind,
      ),
    ) as EntityRefTargetKind[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createEntityRelationTypeRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): EntityRelationTypeRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const loadEndpoints = async (ids: readonly string[]): Promise<EndpointKindRow[]> => {
    if (ids.length === 0) return [];
    return dbProvider()
      .select()
      .from(EntityRelationTypeEndpointKindTable)
      .where(inArray(EntityRelationTypeEndpointKindTable.relationTypeId, [...ids]));
  };

  const list = async (): Promise<EntityRelationType[]> => {
    const rows = await dbProvider()
      .select()
      .from(EntityRelationTypeTable)
      .where(eq(EntityRelationTypeTable.projectId, projectId))
      .orderBy(asc(EntityRelationTypeTable.name));
    const endpoints = await loadEndpoints(rows.map((row) => row.id));
    return rows.map((row) => materialize(row, endpoints));
  };

  const findOne = async (
    condition: ReturnType<typeof eq>,
  ): Promise<EntityRelationType | null> => {
    const rows = await dbProvider()
      .select()
      .from(EntityRelationTypeTable)
      .where(and(eq(EntityRelationTypeTable.projectId, projectId), condition))
      .limit(1);
    if (!rows[0]) return null;
    return materialize(rows[0], await loadEndpoints([rows[0].id]));
  };

  const create = async (value: EntityRelationType): Promise<EntityRelationType> => {
    if (value.projectId !== projectId) throw new Error('关系类型不属于当前项目');
    await dbProvider().insert(EntityRelationTypeTable).values({
      id: value.id,
      projectId: value.projectId,
      name: value.name,
      normalizedName: value.normalizedName,
      description: value.description,
      orientation: value.orientation,
      sourceRole: value.sourceRole,
      targetRole: value.targetRole,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    });
    const endpoints = endpointRows(value);
    if (endpoints.length > 0) {
      await dbProvider().insert(EntityRelationTypeEndpointKindTable).values(endpoints);
    }
    return value;
  };

  const update = async (value: EntityRelationType): Promise<EntityRelationType> => {
    if (value.projectId !== projectId) throw new Error('关系类型不属于当前项目');
    const rows = await dbProvider()
      .update(EntityRelationTypeTable)
      .set({
        name: value.name,
        normalizedName: value.normalizedName,
        description: value.description,
        orientation: value.orientation,
        sourceRole: value.sourceRole,
        targetRole: value.targetRole,
        updatedAt: value.updatedAt,
      })
      .where(
        and(
          eq(EntityRelationTypeTable.id, value.id),
          eq(EntityRelationTypeTable.projectId, projectId),
        ),
      )
      .returning({ id: EntityRelationTypeTable.id });
    if (!rows[0]) throw new Error('关系类型不存在或已被删除');
    await dbProvider()
      .delete(EntityRelationTypeEndpointKindTable)
      .where(eq(EntityRelationTypeEndpointKindTable.relationTypeId, value.id));
    const endpoints = endpointRows(value);
    if (endpoints.length > 0) {
      await dbProvider().insert(EntityRelationTypeEndpointKindTable).values(endpoints);
    }
    return value;
  };

  const remove = async (id: string): Promise<void> => {
    const count = await countRelations(id);
    if (count > 0) throw new Error(`关系类型仍被 ${count} 条关系使用，不能删除`);
    await dbProvider()
      .delete(EntityRelationTypeTable)
      .where(and(eq(EntityRelationTypeTable.id, id), eq(EntityRelationTypeTable.projectId, projectId)));
  };

  const countRelations = async (id: string): Promise<number> => {
    const rows = await dbProvider()
      .select({ count: sql<number>`count(*)` })
      .from(EntityRelationTable)
      .where(
        and(
          eq(EntityRelationTable.projectId, projectId),
          eq(EntityRelationTable.relationTypeId, id),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  };

  return {
    list,
    findById: (id) => findOne(eq(EntityRelationTypeTable.id, id)),
    findByNormalizedName: (normalizedName) =>
      findOne(eq(EntityRelationTypeTable.normalizedName, normalizedName)),
    create,
    update,
    remove,
    countRelations,
  };
}
