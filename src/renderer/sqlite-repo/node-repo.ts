import { getDb, type DbExecutor } from '../lib/db';
import { BookNodeTable, NodeEdgeTable, ProjectTable } from '../schema/drizzle';
import { eq, asc } from 'drizzle-orm';
import type {
  BookNode,
  BookNodeEdge,
  ChapterWritingStatus,
  DriftStatus,
} from '../domain/book-node';

import loglevel from 'loglevel';

const log = loglevel.getLogger('BookNodeRepository');
log.setLevel(loglevel.levels.WARN);

export type BookNodeCreateData = BookNode;
// Flat update shape — BookNode is a discriminated union so `Partial<BookNode>`
// can't carry cross-variant fields (e.g. switching a drift into a chapter by
// setting mainStorylineId + bookOrder + writingStatus together). The repo
// only persists field-by-field, so a flat partial is the right tool here.
export interface BookNodeUpdateData {
  title?: string;
  summary?: string;
  bookOrder?: number | null;
  narrativeOrder?: number | null;
  mainStorylineId?: string | null;
  projectId?: string;
  position?: { x?: number | null; y?: number | null };
  wordCount?: number;
  writingStatus?: ChapterWritingStatus | DriftStatus;
  updatedAt: string;
}
export type BookNodeEdgeUpdateData = Partial<BookNodeEdge>;

export interface BookNodeRepository {
  findById(id: string): Promise<BookNode | null>;
  findAll(): Promise<BookNode[]>;
  create(data: BookNodeCreateData): Promise<BookNode>;
  update(id: string, data: BookNodeUpdateData): Promise<BookNode | null>;
  delete(id: string): Promise<boolean>;
  swapOrder(
    first: { id: string; bookOrder: number },
    second: { id: string; bookOrder: number },
  ): Promise<void>;
}

export interface BookNodeEdgeRepository {
  findAll(): Promise<BookNodeEdge[]>;
  create(input: BookNodeEdge): Promise<BookNodeEdge>;
  update(id: string, data: BookNodeEdgeUpdateData): Promise<BookNodeEdge | null>;
  delete(id: string): Promise<boolean>;
}

export interface BookNodeDataSource {
  nodeRepo: BookNodeRepository;
  edgeRepo: BookNodeEdgeRepository;
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

  if (record.mainStorylineId == null) {
    // Drift row. Force bookOrder to null even if the DB still carries a
    // legacy value — the domain invariant `drift => bookOrder == null` is
    // enforced here at the boundary so callers never see a stale order.
    return {
      ...base,
      mainStorylineId: null,
      bookOrder: null,
      writingStatus: (record.writingStatus ?? 'drifting') as DriftStatus,
    };
  }

  return {
    ...base,
    mainStorylineId: record.mainStorylineId,
    bookOrder: record.bookOrder ?? 0,
    writingStatus: (record.writingStatus ?? 'draft') as ChapterWritingStatus,
  };
}

function toBookNodeEdge(record: typeof NodeEdgeTable.$inferSelect): BookNodeEdge {
  const style = record.styleJson ? JSON.parse(record.styleJson) : undefined;
  const cp = record.controlPointOffsetJson ? JSON.parse(record.controlPointOffsetJson) : undefined;
  const sa = record.sourceAnchorJson ? JSON.parse(record.sourceAnchorJson) : undefined;
  const ta = record.targetAnchorJson ? JSON.parse(record.targetAnchorJson) : undefined;

  return {
    id: record.id,
    projectId: record.projectId,
    sourceNodeId: record.sourceNodeId,
    targetNodeId: record.targetNodeId,
    label: record.label,
    kind: record.kind ?? null,
    weight: record.weight,
    isDirected: record.isDirected ?? true,
    style,
    controlPointOffset: cp,
    sourceAnchor: sa,
    targetAnchor: ta,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
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
        .where(eq(BookNodeTable.projectId, pid))
        .orderBy(asc(BookNodeTable.bookOrder));
      return rows.map(toBookNode);
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
        mainStorylineId: data.mainStorylineId ?? null,
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
      if (updates.mainStorylineId !== undefined)
        updateValues.mainStorylineId = updates.mainStorylineId ?? null;
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

export function createBookNodeEdgeSqliteRepository(
  currentProjectId: string,
  dbOverride?: DbExecutor,
): BookNodeEdgeRepository {
  const dbProvider = () => dbOverride ?? getDb();
  return {
    async findAll() {
      const pid = currentProjectId;
      const rows = await dbProvider()
        .select()
        .from(NodeEdgeTable)
        .where(eq(NodeEdgeTable.projectId, pid))
        .orderBy(asc(NodeEdgeTable.createdAt));
      return rows.map(toBookNodeEdge);
    },

    async create(input: BookNodeEdge) {
      if (!input.projectId || input.projectId !== currentProjectId) {
        throw new Error(
          `Cannot create edge: projectId mismatch. Expected ${currentProjectId}, got ${input.projectId}`,
        );
      }

      const newEdge: typeof NodeEdgeTable.$inferInsert = {
        id: input.id,
        projectId: input.projectId,
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
        label: input.label,
        kind: input.kind,
        weight: input.weight ?? 1,
        isDirected: input.isDirected,
        styleJson: input.style ? JSON.stringify(input.style) : undefined,
        controlPointOffsetJson: input.controlPointOffset
          ? JSON.stringify(input.controlPointOffset)
          : undefined,
        sourceAnchorJson: input.sourceAnchor ? JSON.stringify(input.sourceAnchor) : undefined,
        targetAnchorJson: input.targetAnchor ? JSON.stringify(input.targetAnchor) : undefined,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };

      await dbProvider().insert(NodeEdgeTable).values(newEdge);
      return toBookNodeEdge(newEdge as any);
    },

    async update(id: string, updates: BookNodeEdgeUpdateData) {
      const updateValues: any = {};
      if (updates.label !== undefined) updateValues.label = updates.label;
      if (updates.kind !== undefined) updateValues.kind = updates.kind;
      if (updates.weight !== undefined) updateValues.weight = updates.weight;
      if (updates.style) updateValues.styleJson = JSON.stringify(updates.style);

      if (Object.keys(updateValues).length > 0) {
        updateValues.updatedAt = new Date().toISOString();
        await dbProvider().update(NodeEdgeTable).set(updateValues).where(eq(NodeEdgeTable.id, id));
      }

      const res = await dbProvider().select().from(NodeEdgeTable).where(eq(NodeEdgeTable.id, id));
      return res[0] ? toBookNodeEdge(res[0]) : null;
    },

    async delete(id: string) {
      await dbProvider().delete(NodeEdgeTable).where(eq(NodeEdgeTable.id, id));
      return true;
    },
  };
}
