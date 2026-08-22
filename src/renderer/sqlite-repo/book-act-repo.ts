/**
 * Local SQLite repo for acts (幕) — boundary-based segments of the global
 * reading axis. Thin CRUD; all derivation (membership, segment spans,
 * spread repair) lives in domain/book-act.ts, and orchestration (coordinate
 * creation and auto-naming) in usecase/useBookAct.ts.
 */
import { and, asc, eq } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import { BookActTable } from '../schema/drizzle';
import type { BookAct } from '../domain/book-act';

export type BookActUpdateData = Partial<Omit<BookAct, 'id' | 'projectId' | 'createdAt'>> & {
  updatedAt: string;
};

export interface BookActRepository {
  findById(id: string): Promise<BookAct | null>;
  /** All acts for the project; callers sort via domain sortActs. */
  findAll(): Promise<BookAct[]>;
  create(input: BookAct): Promise<BookAct>;
  update(id: string, data: BookActUpdateData): Promise<BookAct | null>;
  delete(id: string): Promise<boolean>;
  /**
   * Clear the drift binding on every act pointing at a drift (the drift is
   * being deleted or converted to a chapter). Returns the affected rows so
   * the caller can mirror the change into the store + sync. FKs aren't
   * enforced here, so this is the only unbind path.
   */
  unbindForDrift(driftNodeId: string, now: string): Promise<BookAct[]>;
}

function toDomain(record: typeof BookActTable.$inferSelect): BookAct {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    color: record.color,
    startOrder: record.startOrder,
    driftNodeId: record.driftNodeId,
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
      .where(and(eq(BookActTable.id, id), eq(BookActTable.projectId, projectId)))
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
      if (input.projectId !== projectId) throw new Error('Book act projectId mismatch');
      await dbProvider().insert(BookActTable).values({
        id: input.id,
        projectId: input.projectId,
        name: input.name,
        color: input.color,
        startOrder: input.startOrder,
        driftNodeId: input.driftNodeId,
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
      if (data.color !== undefined) values.color = data.color;
      if (data.startOrder !== undefined) values.startOrder = data.startOrder;
      if (data.driftNodeId !== undefined) values.driftNodeId = data.driftNodeId;
      await dbProvider()
        .update(BookActTable)
        .set(values)
        .where(and(eq(BookActTable.id, id), eq(BookActTable.projectId, projectId)));
      return findById(id);
    },

    delete: async (id) => {
      await dbProvider()
        .delete(BookActTable)
        .where(and(eq(BookActTable.id, id), eq(BookActTable.projectId, projectId)));
      return true;
    },

    unbindForDrift: async (driftNodeId, now) => {
      const rows = await dbProvider()
        .select()
        .from(BookActTable)
        .where(
          and(eq(BookActTable.projectId, projectId), eq(BookActTable.driftNodeId, driftNodeId)),
        );
      if (rows.length === 0) return [];
      await dbProvider()
        .update(BookActTable)
        .set({ driftNodeId: null, updatedAt: now })
        .where(
          and(eq(BookActTable.projectId, projectId), eq(BookActTable.driftNodeId, driftNodeId)),
        );
      return rows.map((r) => ({ ...toDomain(r), driftNodeId: null, updatedAt: now }));
    },
  };
}
