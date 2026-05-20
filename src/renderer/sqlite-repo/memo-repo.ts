import { getDb, type DbExecutor } from '../lib/db';
import { MemoTable } from '../schema/drizzle';
import { eq, asc, desc } from 'drizzle-orm';
import type { Memo, MemoPriority, MemoResolution } from '../domain/memo';

export type MemoCreateData = Memo;
export type MemoUpdateData = Partial<Omit<Memo, 'id' | 'createdAt' | 'projectId'>> & {
  updatedAt: string;
};

export interface MemoRepository {
  findById(id: string): Promise<Memo | null>;
  findAll(): Promise<Memo[]>;
  create(input: MemoCreateData): Promise<Memo>;
  update(id: string, data: MemoUpdateData): Promise<Memo | null>;
  delete(id: string): Promise<boolean>;
}

function toDomain(record: typeof MemoTable.$inferSelect): Memo {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    bodyJson: record.bodyJson,
    resolution: record.resolution as MemoResolution,
    priority: (record.priority as MemoPriority | null) ?? null,
    dueAt: record.dueAt,
    orderKey: record.orderKey,
    resolvedAt: record.resolvedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createMemoSqliteRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): MemoRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<Memo | null> => {
    const rows = await dbProvider()
      .select()
      .from(MemoTable)
      .where(eq(MemoTable.id, id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const findAll = async (): Promise<Memo[]> => {
    const rows = await dbProvider()
      .select()
      .from(MemoTable)
      .where(eq(MemoTable.projectId, projectId))
      .orderBy(asc(MemoTable.orderKey), desc(MemoTable.updatedAt));
    return rows.map(toDomain);
  };

  return {
    findById,
    findAll,
    create: async (input) => {
      const row: typeof MemoTable.$inferInsert = {
        id: input.id,
        projectId: input.projectId,
        title: input.title,
        bodyJson: input.bodyJson,
        resolution: input.resolution,
        priority: input.priority,
        dueAt: input.dueAt,
        orderKey: input.orderKey,
        resolvedAt: input.resolvedAt,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
      await dbProvider().insert(MemoTable).values(row);
      return (await findById(input.id))!;
    },
    update: async (id, data) => {
      if (!data.updatedAt) throw new Error('updatedAt is required when updating a memo');

      const updateValues: Partial<typeof MemoTable.$inferInsert> = {
        updatedAt: data.updatedAt,
      };
      if (data.title !== undefined) updateValues.title = data.title;
      if (data.bodyJson !== undefined) updateValues.bodyJson = data.bodyJson;
      if (data.resolution !== undefined) updateValues.resolution = data.resolution;
      if (data.priority !== undefined) updateValues.priority = data.priority;
      if (data.dueAt !== undefined) updateValues.dueAt = data.dueAt;
      if (data.orderKey !== undefined) updateValues.orderKey = data.orderKey;
      if (data.resolvedAt !== undefined) updateValues.resolvedAt = data.resolvedAt;

      await dbProvider().update(MemoTable).set(updateValues).where(eq(MemoTable.id, id));
      return findById(id);
    },
    delete: async (id) => {
      await dbProvider().delete(MemoTable).where(eq(MemoTable.id, id));
      return true;
    },
  };
}
