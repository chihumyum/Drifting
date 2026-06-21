/**
 * Local SQLite repo for drift groups (左栏分组) — nested folders for drift
 * nodes. Thin CRUD; nesting / cycle-guard / reparent-on-delete derivation
 * lives in domain/drift-group.ts and orchestration in usecase/useDriftGroup.ts.
 */
import { asc, eq } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import { DriftGroupTable } from '../schema/drizzle';
import type { DriftGroup } from '../domain/drift-group';

export type DriftGroupUpdateData = Partial<
  Omit<DriftGroup, 'id' | 'projectId' | 'createdAt'>
> & {
  updatedAt: string;
};

export interface DriftGroupRepository {
  findById(id: string): Promise<DriftGroup | null>;
  /** All groups for the project; callers nest/sort via domain helpers. */
  findAll(): Promise<DriftGroup[]>;
  create(input: DriftGroup): Promise<DriftGroup>;
  update(id: string, data: DriftGroupUpdateData): Promise<DriftGroup | null>;
  delete(id: string): Promise<boolean>;
}

function toDomain(record: typeof DriftGroupTable.$inferSelect): DriftGroup {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    parentGroupId: record.parentGroupId,
    color: record.color,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createDriftGroupRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): DriftGroupRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<DriftGroup | null> => {
    const rows = await dbProvider()
      .select()
      .from(DriftGroupTable)
      .where(eq(DriftGroupTable.id, id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  return {
    findById,

    findAll: async () => {
      const rows = await dbProvider()
        .select()
        .from(DriftGroupTable)
        .where(eq(DriftGroupTable.projectId, projectId))
        .orderBy(asc(DriftGroupTable.createdAt));
      return rows.map(toDomain);
    },

    create: async (input) => {
      await dbProvider().insert(DriftGroupTable).values({
        id: input.id,
        projectId: input.projectId,
        name: input.name,
        parentGroupId: input.parentGroupId,
        color: input.color,
        sortOrder: input.sortOrder,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      return (await findById(input.id))!;
    },

    update: async (id, data) => {
      const values: Partial<typeof DriftGroupTable.$inferInsert> = {
        updatedAt: data.updatedAt,
      };
      if (data.name !== undefined) values.name = data.name;
      if (data.parentGroupId !== undefined) values.parentGroupId = data.parentGroupId;
      if (data.color !== undefined) values.color = data.color;
      if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;
      await dbProvider().update(DriftGroupTable).set(values).where(eq(DriftGroupTable.id, id));
      return findById(id);
    },

    delete: async (id) => {
      await dbProvider().delete(DriftGroupTable).where(eq(DriftGroupTable.id, id));
      return true;
    },
  };
}
