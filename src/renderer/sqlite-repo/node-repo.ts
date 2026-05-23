import { getDb, type DbExecutor } from '../lib/db';
import { BookNodeTable, ProjectTable } from '../schema/drizzle';
import { eq, asc, isNull, isNotNull, and } from 'drizzle-orm';
import type {
  BookNode,
  BookNodeKind,
  ChapterWritingStatus,
  DriftStatus,
} from '../domain/book-node';

import loglevel from 'loglevel';

const log = loglevel.getLogger('BookNodeRepository');
log.setLevel(loglevel.levels.WARN);

export type BookNodeCreateData = BookNode;
// Flat update shape — BookNode is a discriminated union so `Partial<BookNode>`
// can't carry cross-variant fields (e.g. switching a drift into a chapter by
// setting kind + bookOrder + writingStatus together). The repo only persists
// field-by-field, so a flat partial is the right tool here.
export interface BookNodeUpdateData {
  title?: string;
  summary?: string;
  bookOrder?: number | null;
  narrativeOrder?: number | null;
  kind?: BookNodeKind;
  projectId?: string;
  position?: { x?: number | null; y?: number | null };
  wordCount?: number;
  writingStatus?: ChapterWritingStatus | DriftStatus;
  updatedAt: string;
}

export interface BookNodeRepository {
  findById(id: string): Promise<BookNode | null>;
  findAll(): Promise<BookNode[]>;
  findTrashed(): Promise<Array<BookNode & { deletedAt: string }>>;
  create(data: BookNodeCreateData): Promise<BookNode>;
  update(id: string, data: BookNodeUpdateData): Promise<BookNode | null>;
  delete(id: string): Promise<boolean>;
  softDelete(id: string): Promise<boolean>;
  restore(id: string): Promise<boolean>;
  swapOrder(
    first: { id: string; bookOrder: number },
    second: { id: string; bookOrder: number },
  ): Promise<void>;
}

function toBookNode(record: typeof BookNodeTable.$inferSelect): BookNode {
  const base = {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    summary: record.summary,
    narrativeOrder: record.narrativeOrder ?? null,
    position: { x: record.positionX, y: record.positionY },
    wordCount: record.wordCount ?? 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  // Discriminator is the explicit `kind` column. mainStorylineId is no longer
  // a column; the primary storyline (if any) is sourced from the
  // node_storyline_link table.
  const kind: BookNodeKind = record.kind === 'chapter' ? 'chapter' : 'drift';

  if (kind === 'drift') {
    return {
      ...base,
      kind: 'drift',
      bookOrder: null,
      writingStatus: (record.writingStatus ?? 'drifting') as DriftStatus,
    };
  }

  return {
    ...base,
    kind: 'chapter',
    bookOrder: record.bookOrder ?? 0,
    writingStatus: (record.writingStatus ?? 'draft') as ChapterWritingStatus,
  };
}

export function createBookNodeSqliteRepository(
  currentProject: string,
  dbOverride?: DbExecutor,
): BookNodeRepository {
  const dbProvider = () => dbOverride ?? getDb();
  return {
    async findById(id: string) {
      const rows = await dbProvider()
        .selectDistinct()
        .from(BookNodeTable)
        .where(eq(BookNodeTable.id, id));
      return rows[0] ? toBookNode(rows[0]) : null;
    },

    async findAll() {
      const pid = currentProject;
      const rows = await dbProvider()
        .select()
        .from(BookNodeTable)
        .where(and(eq(BookNodeTable.projectId, pid), isNull(BookNodeTable.deletedAt)))
        .orderBy(asc(BookNodeTable.bookOrder));
      return rows.map(toBookNode);
    },

    async findTrashed() {
      const pid = currentProject;
      const rows = await dbProvider()
        .select()
        .from(BookNodeTable)
        .where(and(eq(BookNodeTable.projectId, pid), isNotNull(BookNodeTable.deletedAt)));
      return rows.map((r) => ({ ...toBookNode(r), deletedAt: r.deletedAt as string }));
    },

    async create(data: BookNodeCreateData) {
      if (!data.projectId || data.projectId !== currentProject) {
        throw new Error(
          `Cannot create node: projectId mismatch. Expected ${currentProject}, got ${data.projectId}`,
        );
      }

      const projectExists = await dbProvider()
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, data.projectId))
        .limit(1);
      if (projectExists.length === 0) {
        throw new Error(`Project with ID ${data.projectId} does not exist. Cannot create node.`);
      }

      const newNode: typeof BookNodeTable.$inferInsert = {
        id: data.id,
        projectId: data.projectId,
        title: data.title,
        bookOrder: data.bookOrder,
        narrativeOrder: data.narrativeOrder,
        summary: data.summary,
        kind: data.kind,
        positionX: data.position.x,
        positionY: data.position.y,
        wordCount: data.wordCount ?? 0,
        writingStatus: data.writingStatus ?? 'draft',
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };

      await dbProvider().insert(BookNodeTable).values(newNode);

      return toBookNode({
        ...newNode,
        positionX: newNode.positionX!,
        positionY: newNode.positionY!,
        wordCount: newNode.wordCount ?? 0,
        writingStatus: newNode.writingStatus ?? 'draft',
      } as typeof BookNodeTable.$inferSelect);
    },

    async update(id: string, updates: BookNodeUpdateData) {
      const existing = await dbProvider()
        .select()
        .from(BookNodeTable)
        .where(eq(BookNodeTable.id, id))
        .limit(1);
      if (!existing[0]) {
        log.warn(`[BookNodeRepository] update: Node with ID ${id} does not exist.`);
        return null;
      }

      const updateValues: Partial<typeof BookNodeTable.$inferInsert> = {
        updatedAt: updates.updatedAt,
      };

      if (updates.title !== undefined) updateValues.title = updates.title;
      if (updates.bookOrder !== undefined) updateValues.bookOrder = updates.bookOrder;
      if (updates.narrativeOrder !== undefined) updateValues.narrativeOrder = updates.narrativeOrder;
      if (updates.summary !== undefined) updateValues.summary = updates.summary;
      if (updates.projectId !== undefined) updateValues.projectId = updates.projectId;
      if (updates.wordCount !== undefined) updateValues.wordCount = updates.wordCount;
      if (updates.writingStatus !== undefined) updateValues.writingStatus = updates.writingStatus;

      if (updates.position) {
        if (updates.position.x !== undefined && updates.position.x !== null)
          updateValues.positionX = updates.position.x;
        if (updates.position.y !== undefined && updates.position.y !== null)
          updateValues.positionY = updates.position.y;
      }

      await dbProvider().update(BookNodeTable).set(updateValues).where(eq(BookNodeTable.id, id));

      // Fetch updated
      const updated = await dbProvider()
        .select()
        .from(BookNodeTable)
        .where(eq(BookNodeTable.id, id))
        .limit(1);
      return updated[0] ? toBookNode(updated[0]) : null;
    },

    async delete(id: string) {
      const result = await dbProvider().delete(BookNodeTable).where(eq(BookNodeTable.id, id));
      return (result as any).rowsAffected > 0;
    },

    async softDelete(id: string) {
      const now = new Date().toISOString();
      const result = await dbProvider()
        .update(BookNodeTable)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(BookNodeTable.id, id));
      return (result as any).rowsAffected > 0;
    },

    async restore(id: string) {
      const now = new Date().toISOString();
      const result = await dbProvider()
        .update(BookNodeTable)
        .set({ deletedAt: null, updatedAt: now })
        .where(eq(BookNodeTable.id, id));
      return (result as any).rowsAffected > 0;
    },

    async swapOrder(
      first: { id: string; bookOrder: number },
      second: { id: string; bookOrder: number },
    ) {
      const now = new Date().toISOString();
      const db = dbProvider();
      if (dbOverride) {
        await db
          .update(BookNodeTable)
          .set({ bookOrder: second.bookOrder, updatedAt: now })
          .where(eq(BookNodeTable.id, first.id));
        await db
          .update(BookNodeTable)
          .set({ bookOrder: first.bookOrder, updatedAt: now })
          .where(eq(BookNodeTable.id, second.id));
        return;
      }

      await db.transaction(async (tx) => {
        await tx
          .update(BookNodeTable)
          .set({ bookOrder: second.bookOrder, updatedAt: now })
          .where(eq(BookNodeTable.id, first.id));

        await tx
          .update(BookNodeTable)
          .set({ bookOrder: first.bookOrder, updatedAt: now })
          .where(eq(BookNodeTable.id, second.id));
      });
    },
  };
}

