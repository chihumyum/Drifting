import { getDb, type DbExecutor } from '../lib/db';
import { BookNodeTable, ProjectTable } from '../schema/drizzle';
import { eq, asc, isNull, isNotNull, and } from 'drizzle-orm';
import type {
  BookNode,
  BookNodeKind,
  ChapterWritingStatus,
  DriftStatus,
  WordCountBasisKind,
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
  wordCountBasisKind?: 'seed' | 'yjs' | null;
  wordCountBasisHash?: string | null;
  wordCountBasisRevision?: number | null;
  wordCountBasisServerSeq?: number | null;
  writingStatus?: ChapterWritingStatus | DriftStatus;
  // Drift group membership (null = move to root / ungrouped). Drift-only.
  driftGroupId?: string | null;
  updatedAt: string;
}

export interface BookNodeUpdateOptions {
  /**
   * When present, the update is a single-statement compare-and-swap against
   * the exact durable revision observed by an Agent read receipt.
   */
  expectedRevision?: string;
}

export class BookNodeRevisionConflictError extends Error {
  readonly code = 'STALE_REVISION';

  constructor(
    readonly nodeId: string,
    readonly expectedRevision: string,
  ) {
    super(
      `Book node ${nodeId} changed after Agent observation ${expectedRevision}.`,
    );
    this.name = 'BookNodeRevisionConflictError';
  }
}

export interface BookNodeRepository {
  findById(id: string): Promise<BookNode | null>;
  findAll(): Promise<BookNode[]>;
  findTrashed(): Promise<Array<BookNode & { deletedAt: string }>>;
  create(data: BookNodeCreateData): Promise<BookNode>;
  update(
    id: string,
    data: BookNodeUpdateData,
    options?: BookNodeUpdateOptions,
  ): Promise<BookNode | null>;
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
    driftGroupId: record.driftGroupId ?? null,
    position: { x: record.positionX, y: record.positionY },
    wordCount: record.wordCount ?? 0,
    wordCountBasisKind: (
      record.wordCountBasisKind === 'seed' || record.wordCountBasisKind === 'yjs'
        ? record.wordCountBasisKind
        : null
    ) as WordCountBasisKind | null,
    wordCountBasisHash: record.wordCountBasisHash ?? null,
    wordCountBasisRevision: record.wordCountBasisRevision ?? null,
    wordCountBasisServerSeq: record.wordCountBasisServerSeq ?? null,
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
        driftGroupId: data.driftGroupId ?? null,
        positionX: data.position.x,
        positionY: data.position.y,
        wordCount: data.wordCount ?? 0,
        wordCountBasisKind: data.wordCountBasisKind ?? null,
        wordCountBasisHash: data.wordCountBasisHash ?? null,
        wordCountBasisRevision: data.wordCountBasisRevision ?? null,
        wordCountBasisServerSeq: data.wordCountBasisServerSeq ?? null,
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

    async update(id: string, updates: BookNodeUpdateData, options = {}) {
      if (updates.projectId !== undefined && updates.projectId !== currentProject) {
        throw new Error('Cannot move a book node between projects');
      }
      const updateValues: Partial<typeof BookNodeTable.$inferInsert> = {
        updatedAt: updates.updatedAt,
      };

      if (updates.title !== undefined) updateValues.title = updates.title;
      if (updates.kind !== undefined) updateValues.kind = updates.kind;
      if (updates.bookOrder !== undefined) updateValues.bookOrder = updates.bookOrder;
      if (updates.narrativeOrder !== undefined) updateValues.narrativeOrder = updates.narrativeOrder;
      if (updates.summary !== undefined) updateValues.summary = updates.summary;
      if (updates.projectId !== undefined) updateValues.projectId = updates.projectId;
      if (updates.wordCount !== undefined) updateValues.wordCount = updates.wordCount;
      if (updates.wordCountBasisKind !== undefined)
        updateValues.wordCountBasisKind = updates.wordCountBasisKind;
      if (updates.wordCountBasisHash !== undefined)
        updateValues.wordCountBasisHash = updates.wordCountBasisHash;
      if (updates.wordCountBasisRevision !== undefined)
        updateValues.wordCountBasisRevision = updates.wordCountBasisRevision;
      if (updates.wordCountBasisServerSeq !== undefined)
        updateValues.wordCountBasisServerSeq = updates.wordCountBasisServerSeq;
      if (updates.writingStatus !== undefined) updateValues.writingStatus = updates.writingStatus;
      if (updates.driftGroupId !== undefined) updateValues.driftGroupId = updates.driftGroupId;

      if (updates.position) {
        if (updates.position.x !== undefined && updates.position.x !== null)
          updateValues.positionX = updates.position.x;
        if (updates.position.y !== undefined && updates.position.y !== null)
          updateValues.positionY = updates.position.y;
      }

      const conditions = [
        eq(BookNodeTable.id, id),
        eq(BookNodeTable.projectId, currentProject),
        isNull(BookNodeTable.deletedAt),
      ];
      if (options.expectedRevision !== undefined) {
        conditions.push(
          eq(BookNodeTable.updatedAt, options.expectedRevision),
        );
      }
      const updated = await dbProvider()
        .update(BookNodeTable)
        .set(updateValues)
        .where(and(...conditions))
        .returning();
      if (!updated[0]) {
        if (options.expectedRevision !== undefined) {
          throw new BookNodeRevisionConflictError(
            id,
            options.expectedRevision,
          );
        }
        log.warn(
          `[BookNodeRepository] update: Node with ID ${id} does not exist in project ${currentProject}.`,
        );
        return null;
      }
      return toBookNode(updated[0]);
    },

    async delete(id: string) {
      const result = await dbProvider()
        .delete(BookNodeTable)
        .where(and(eq(BookNodeTable.id, id), eq(BookNodeTable.projectId, currentProject)));
      return (result as any).rowsAffected > 0;
    },

    async softDelete(id: string) {
      const now = new Date().toISOString();
      const result = await dbProvider()
        .update(BookNodeTable)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(BookNodeTable.id, id), eq(BookNodeTable.projectId, currentProject)));
      return (result as any).rowsAffected > 0;
    },

    async restore(id: string) {
      const now = new Date().toISOString();
      const result = await dbProvider()
        .update(BookNodeTable)
        .set({ deletedAt: null, updatedAt: now })
        .where(and(eq(BookNodeTable.id, id), eq(BookNodeTable.projectId, currentProject)));
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
          .where(and(eq(BookNodeTable.id, first.id), eq(BookNodeTable.projectId, currentProject)));
        await db
          .update(BookNodeTable)
          .set({ bookOrder: first.bookOrder, updatedAt: now })
          .where(and(eq(BookNodeTable.id, second.id), eq(BookNodeTable.projectId, currentProject)));
        return;
      }

      await db.transaction(async (tx) => {
        await tx
          .update(BookNodeTable)
          .set({ bookOrder: second.bookOrder, updatedAt: now })
          .where(and(eq(BookNodeTable.id, first.id), eq(BookNodeTable.projectId, currentProject)));

        await tx
          .update(BookNodeTable)
          .set({ bookOrder: first.bookOrder, updatedAt: now })
          .where(and(eq(BookNodeTable.id, second.id), eq(BookNodeTable.projectId, currentProject)));
      });
    },
  };
}
