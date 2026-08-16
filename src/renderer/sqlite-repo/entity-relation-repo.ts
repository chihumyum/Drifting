import { v7 as uuidv7 } from 'uuid';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  EntityRelationTable,
  StorylineTable,
} from '../schema/drizzle';
import {
  isStructuralEntityKind,
  type EntityRefSourceKind,
  type EntityRefTargetKind,
  type EntityKind,
  type StructuralEntityKind,
} from '../domain/entity-kinds';

// Entity relations are user-curated cross-entity links. fromKind is any
// EntityKind (memo / material can link OUT); toKind is constrained to
// structural — see isStructuralEntityKind below and the runtime guard in
// addRelation. The same pair with different relation types stays as separate
// rows so the story graph can render them as distinct semantic edges.

export interface EntityRelationRecord {
  id: string;
  projectId: string;
  fromKind: EntityKind;
  fromId: string;
  toKind: StructuralEntityKind;
  toId: string;
  relationTypeId: string;
  createdAt: string;
  updatedAt: string;
}

// Backlink projection joined with the from-entity's display title.
export interface EntityRelationBacklink {
  id: string;
  fromKind: EntityKind;
  fromId: string;
  fromTitle: string;
  toKind: StructuralEntityKind;
  toId: string;
  relationTypeId: string;
  createdAt: string;
}

export interface EntityRelationRepository {
  addRelation(
    projectId: string,
    fromKind: EntityRefSourceKind,
    fromId: string,
    toKind: EntityRefTargetKind,
    toId: string,
    options: { relationTypeId: string },
  ): Promise<EntityRelationRecord>;

  // Deletes a single row by id. Pair-based delete is unsound now that the same
  // pair can carry multiple relation types — callers hold the row id.
  removeRelation(id: string): Promise<void>;

  listRelationsFromSource(
    fromKind: EntityKind,
    fromId: string,
  ): Promise<EntityRelationRecord[]>;

  listBacklinksToTarget(
    toKind: StructuralEntityKind,
    toId: string,
  ): Promise<EntityRelationBacklink[]>;

  countDistinctSourcesByTarget(
    toKind: StructuralEntityKind,
    toId: string,
  ): Promise<number>;

  deleteAllForTarget(toKind: StructuralEntityKind, toId: string): Promise<void>;
  deleteAllForSource(fromKind: EntityKind, fromId: string): Promise<void>;
}

function toRecord(
  row: typeof EntityRelationTable.$inferSelect,
): EntityRelationRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    fromKind: row.fromKind as EntityKind,
    fromId: row.fromId,
    toKind: row.toKind as StructuralEntityKind,
    toId: row.toId,
    relationTypeId: row.relationTypeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createEntityRelationRepository(dbOverride?: DbExecutor): EntityRelationRepository {
  const dbProvider = () => dbOverride ?? getDb();
  const addRelation = async (
    projectId: string,
    fromKind: EntityRefSourceKind,
    fromId: string,
    toKind: EntityRefTargetKind,
    toId: string,
    options: { relationTypeId: string },
  ): Promise<EntityRelationRecord> => {
    if (!isStructuralEntityKind(toKind)) {
      throw new Error(
        `Cannot create entity relation: toKind '${toKind}' is not a structural kind ` +
          `(memo / material can only appear as fromKind).`,
      );
    }
    const db = dbProvider();
    const now = new Date().toISOString();
    const row = {
      id: uuidv7(),
      projectId,
      fromKind,
      fromId,
      toKind,
      toId,
      relationTypeId: options.relationTypeId,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(EntityRelationTable).values(row);
    return toRecord(row as typeof EntityRelationTable.$inferSelect);
  };

  const removeRelation = async (id: string): Promise<void> => {
    await dbProvider().delete(EntityRelationTable).where(eq(EntityRelationTable.id, id));
  };

  const listRelationsFromSource = async (
    fromKind: EntityKind,
    fromId: string,
  ): Promise<EntityRelationRecord[]> => {
    const rows = await dbProvider()
      .select()
      .from(EntityRelationTable)
      .where(
        and(
          eq(EntityRelationTable.fromKind, fromKind),
          eq(EntityRelationTable.fromId, fromId),
        ),
      )
      .orderBy(desc(EntityRelationTable.createdAt));
    return rows.map(toRecord);
  };

  // Patches have no stable display name here yet; memo / material from-sides
  // are joined separately when the right sidebar needs them — for the panel's
  // backlink list, only structural display names are needed today.
  const listBacklinksToTarget = async (
    toKind: StructuralEntityKind,
    toId: string,
  ): Promise<EntityRelationBacklink[]> => {
    const rows = await dbProvider()
      .select({
        id: EntityRelationTable.id,
        fromKind: EntityRelationTable.fromKind,
        fromId: EntityRelationTable.fromId,
        toKind: EntityRelationTable.toKind,
        toId: EntityRelationTable.toId,
        relationTypeId: EntityRelationTable.relationTypeId,
        createdAt: EntityRelationTable.createdAt,
        nodeTitle: BookNodeTable.title,
        elementName: BookElementTable.name,
        categoryName: ElementCategoryTable.name,
        storylineName: StorylineTable.name,
      })
      .from(EntityRelationTable)
      .leftJoin(
        BookNodeTable,
        and(
          eq(EntityRelationTable.fromKind, 'node'),
          eq(EntityRelationTable.fromId, BookNodeTable.id),
        ),
      )
      .leftJoin(
        BookElementTable,
        and(
          eq(EntityRelationTable.fromKind, 'element'),
          eq(EntityRelationTable.fromId, BookElementTable.id),
        ),
      )
      .leftJoin(
        ElementCategoryTable,
        and(
          eq(EntityRelationTable.fromKind, 'category'),
          eq(EntityRelationTable.fromId, ElementCategoryTable.id),
        ),
      )
      .leftJoin(
        StorylineTable,
        and(
          eq(EntityRelationTable.fromKind, 'storyline'),
          eq(EntityRelationTable.fromId, StorylineTable.id),
        ),
      )
      .where(
        and(
          eq(EntityRelationTable.toKind, toKind),
          eq(EntityRelationTable.toId, toId),
        ),
      )
      .orderBy(desc(EntityRelationTable.createdAt));

    return rows.map((row) => ({
      id: row.id,
      fromKind: row.fromKind as EntityKind,
      fromId: row.fromId,
      fromTitle:
        row.nodeTitle ?? row.elementName ?? row.categoryName ?? row.storylineName ?? '',
      toKind: row.toKind as StructuralEntityKind,
      toId: row.toId,
      relationTypeId: row.relationTypeId,
      createdAt: row.createdAt,
    }));
  };

  const countDistinctSourcesByTarget = async (
    toKind: StructuralEntityKind,
    toId: string,
  ): Promise<number> => {
    const rows = await dbProvider()
      .select({
        count: sql<number>`count(distinct ${EntityRelationTable.fromKind} || ':' || ${EntityRelationTable.fromId})`,
      })
      .from(EntityRelationTable)
      .where(
        and(
          eq(EntityRelationTable.toKind, toKind),
          eq(EntityRelationTable.toId, toId),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  };

  const deleteAllForTarget = async (
    toKind: StructuralEntityKind,
    toId: string,
  ): Promise<void> => {
    await dbProvider()
      .delete(EntityRelationTable)
      .where(
        and(
          eq(EntityRelationTable.toKind, toKind),
          eq(EntityRelationTable.toId, toId),
        ),
      );
  };

  const deleteAllForSource = async (
    fromKind: EntityKind,
    fromId: string,
  ): Promise<void> => {
    await dbProvider()
      .delete(EntityRelationTable)
      .where(
        and(
          eq(EntityRelationTable.fromKind, fromKind),
          eq(EntityRelationTable.fromId, fromId),
        ),
      );
  };

  return {
    addRelation,
    removeRelation,
    listRelationsFromSource,
    listBacklinksToTarget,
    countDistinctSourcesByTarget,
    deleteAllForTarget,
    deleteAllForSource,
  };
}
