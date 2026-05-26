import { getDb, type DbExecutor } from '../lib/db';
import { BookElementTable } from '../schema/drizzle';
import { eq, desc, and, isNull, isNotNull } from 'drizzle-orm';
import { decodeAliases, encodeAliases, type BookElement } from '../domain/book-element';

export type ElementCreateData = BookElement;
export type ElementUpdateData = Partial<
  Omit<BookElement, 'id' | 'createdAt'>
> & { updatedAt: string };

export interface ElementRepository {
  findById(id: string): Promise<BookElement | null>;
  findAll(): Promise<BookElement[]>;
  findTrashed(): Promise<Array<BookElement & { deletedAt: string }>>;
  findAllByCategory(categoryId: string): Promise<BookElement[]>;
  create(input: ElementCreateData): Promise<BookElement>;
  update(id: string, element: ElementUpdateData): Promise<BookElement | null>;
  delete(id: string): Promise<boolean>;
  softDelete(id: string): Promise<boolean>;
  restore(id: string): Promise<boolean>;
}

function toDomain(record: typeof BookElementTable.$inferSelect): BookElement {
  return {
    id: record.id,
    projectId: record.projectId,
    categoryId: record.categoryId,
    name: record.name,
    summary: record.summary,
    contentJson: record.contentJson,
    kvJson: record.kvJson ?? '[]',
    aliases: decodeAliases(record.aliasesJson),
    groupName: record.groupName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createBookElementSqliteRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): ElementRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<BookElement | null> => {
    const rows = await dbProvider()
      .select()
      .from(BookElementTable)
      .where(eq(BookElementTable.id, id))
      .limit(1);

    if (rows.length === 0) return null;

    return rows[0] ? toDomain(rows[0]) : null;
  };

  const findAll = async (): Promise<BookElement[]> => {
    const rows = await dbProvider()
      .select()
      .from(BookElementTable)
      .where(and(eq(BookElementTable.projectId, projectId), isNull(BookElementTable.deletedAt)))
      .orderBy(desc(BookElementTable.updatedAt));

    return rows.map(toDomain);
  };

  const findTrashed = async (): Promise<Array<BookElement & { deletedAt: string }>> => {
    const rows = await dbProvider()
      .select()
      .from(BookElementTable)
      .where(and(eq(BookElementTable.projectId, projectId), isNotNull(BookElementTable.deletedAt)));
    return rows.map((r) => ({ ...toDomain(r), deletedAt: r.deletedAt as string }));
  };

  const findAllByCategory = async (categoryId: string): Promise<BookElement[]> => {
    const rows = await dbProvider()
      .select()
      .from(BookElementTable)
      .where(
        and(
          eq(BookElementTable.projectId, projectId),
          eq(BookElementTable.categoryId, categoryId),
          isNull(BookElementTable.deletedAt),
        ),
      )
      .orderBy(desc(BookElementTable.updatedAt));

    return rows.map(toDomain);
  };

  const create = async (input: ElementCreateData): Promise<BookElement> => {
    const newElement: typeof BookElementTable.$inferInsert = {
      id: input.id,
      projectId: input.projectId,
      categoryId: input.categoryId,
      name: input.name,
      summary: input.summary,
      contentJson: input.contentJson,
      kvJson: input.kvJson ?? '[]',
      aliasesJson: encodeAliases(input.aliases),
      groupName: input.groupName,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };

    await dbProvider().insert(BookElementTable).values(newElement);

    return (await findById(input.id))!;
  };

  const update = async (id: string, data: ElementUpdateData): Promise<BookElement | null> => {
    if (!data.updatedAt) {
      throw new Error('updatedAt is required for updating an element');
    }

    const updateValues: Partial<typeof BookElementTable.$inferInsert> = {
      updatedAt: data.updatedAt,
    };
    if (data.categoryId !== undefined) updateValues.categoryId = data.categoryId;
    if (data.name !== undefined) updateValues.name = data.name;
    if (data.summary !== undefined) updateValues.summary = data.summary;
    if (data.contentJson !== undefined) updateValues.contentJson = data.contentJson;
    if (data.kvJson !== undefined) updateValues.kvJson = data.kvJson;
    if (data.aliases !== undefined) updateValues.aliasesJson = encodeAliases(data.aliases);
    if (data.groupName !== undefined) updateValues.groupName = data.groupName;

    await dbProvider()
      .update(BookElementTable)
      .set(updateValues)
      .where(eq(BookElementTable.id, id));

    return findById(id);
  };

  return {
    findById,
    findAll,
    findTrashed,
    findAllByCategory,
    create,
    update,
    delete: async (id) => {
      await dbProvider().delete(BookElementTable).where(eq(BookElementTable.id, id));
      return true;
    },
    softDelete: async (id) => {
      const now = new Date().toISOString();
      await dbProvider()
        .update(BookElementTable)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(BookElementTable.id, id));
      return true;
    },
    restore: async (id) => {
      const now = new Date().toISOString();
      await dbProvider()
        .update(BookElementTable)
        .set({ deletedAt: null, updatedAt: now })
        .where(eq(BookElementTable.id, id));
      return true;
    },
  };
}
