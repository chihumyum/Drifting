/**
 * Local SQLite repo for acts (幕) — boundary-based segments of the global
 * reading axis. Thin CRUD; all derivation (membership, segment spans,
 * spread repair) lives in domain/book-act.ts, and orchestration (opener
 * promotion on delete, auto-naming) in usecase/useBookAct.ts.
 */
import { asc, eq } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import { BookActTable } from '../schema/drizzle';
import type { BookAct } from '../domain/book-act';

export type BookActUpdateData = Partial<Omit<BookAct, 'id' | 'projectId' | 'createdAt'>> & {
  updatedAt: string;
};

export interface BookActRepository {
  findById(id: string): Promise<BookAct | null>;
  /** All acts for the project; callers sort via domain sortActs (null first). */
  findAll(): Promise<BookAct[]>;
  create(input: BookAct): Promise<BookAct>;
  update(id: string, data: BookActUpdateData): Promise<BookAct | null>;
  delete(id: string): Promise<boolean>;
}

function toDomain(record: typeof BookActTable.$inferSelect): BookAct {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    summary: record.summary,
    color: record.color,
    startOrder: record.startOrder,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createBookActRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): BookActRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<BookAct | null> => {
    const rows = await dbProvider()
      .select()
      .from(BookActTable)
      .where(eq(BookActTable.id, id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  return {
    findById,

    findAll: async () => {
      const rows = await dbProvider()
        .select()
        .from(BookActTable)
        .where(eq(BookActTable.projectId, projectId))
        .orderBy(asc(BookActTable.startOrder));
      return rows.map(toDomain);
    },

    create: async (input) => {
      await dbProvider().insert(BookActTable).values({
        id: input.id,
        projectId: input.projectId,
        name: input.name,
        summary: input.summary,
        color: input.color,
        startOrder: input.startOrder,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      return (await findById(input.id))!;
    },

    update: async (id, data) => {
      const values: Partial<typeof BookActTable.$inferInsert> = {
        updatedAt: data.updatedAt,
      };
      if (data.name !== undefined) values.name = data.name;
      if (data.summary !== undefined) values.summary = data.summary;
      if (data.color !== undefined) values.color = data.color;
      if (data.startOrder !== undefined) values.startOrder = data.startOrder;
      await dbProvider().update(BookActTable).set(values).where(eq(BookActTable.id, id));
      return findById(id);
    },

    delete: async (id) => {
      await dbProvider().delete(BookActTable).where(eq(BookActTable.id, id));
      return true;
    },
  };
}
