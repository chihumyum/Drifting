import { getDb } from '../lib/db';
import { storyNodes, storyNodeEdges, projects } from '../schema/drizzle';
import { eq, asc, and } from 'drizzle-orm';
import type { BookNode, BookNodeEdge, BookNodePosition } from '../domain/book-node';

import { v7 as uuidv7 } from 'uuid';


type PositionInput = Partial<BookNodePosition> | undefined;

// Use Omit to enforce domain types while allowing optional system fields
export type CreateBookNodeRepoInput = Omit<BookNode, 'id' | 'createdAt' | 'updatedAt' | 'storylineIds' | 'tagIds'> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  // projectId is technically required in BookNode, but repo might default it. 
  // User wants strict enforcement. Let's make projectId optional only if we really support default.
  // But start/end MUST be present.
};

export interface BookNodeUpdateData {
  projectId?: string;
  title?: string;
  start?: number;
  end?: number;
  summary?: string | null;
  storyStageId?: string | null;
  position?: PositionInput;
  createdAt?: string;
  updatedAt?: string;
}

export type CreateBookNodeEdgeInput = {
  projectId?: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string | null;
  weight?: number;
  style?: BookNodeEdge['style'];
  controlPointOffset?: BookNodeEdge['controlPointOffset'];
  sourceAnchor?: BookNodeEdge['sourceAnchor'];
  targetAnchor?: BookNodeEdge['targetAnchor'];
};

export interface BookNodeEdgeUpdateData {
  projectId?: string;
  sourceNodeId?: string;
  targetNodeId?: string;

  label?: string | null;
  weight?: number;
  style?: BookNodeEdge['style'];
  controlPointOffset?: BookNodeEdge['controlPointOffset'];
  sourceAnchor?: BookNodeEdge['sourceAnchor'];
  targetAnchor?: BookNodeEdge['targetAnchor'];
  updatedAt?: string;
}

export interface BookNodeRepository {
  findById(id: string): Promise<BookNode | null>;
  findAll(projectId?: string): Promise<BookNode[]>;
  create(data: CreateBookNodeRepoInput): Promise<BookNode>;
  update(id: string, data: BookNodeUpdateData): Promise<BookNode | null>;
  delete(id: string): Promise<boolean>;
  swapOrder(first: Pick<BookNode, 'id' | 'start'>, second: Pick<BookNode, 'id' | 'start'>): Promise<void>;
}

export interface BookNodeEdgeRepository {
  findAll(projectId?: string): Promise<BookNodeEdge[]>;
  create(input: CreateBookNodeEdgeInput): Promise<BookNodeEdge>;
  update(id: string, data: BookNodeEdgeUpdateData): Promise<BookNodeEdge | null>;
  delete(id: string): Promise<boolean>;
}

export interface BookNodeDataSource {
  nodeRepo: BookNodeRepository;
  edgeRepo: BookNodeEdgeRepository;
}



function toBookNode(record: typeof storyNodes.$inferSelect): BookNode {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    start: record.start,
    end: record.end ?? 0, // Domain requires number, default to 0 if null
    summary: record.summary ?? '',
    storyStageId: record.storyStageId ?? '',
    storylineIds: [], // TODO: Implement join if needed, or separate fetch
    tagIds: [], // TODO: Implement join if needed
    position: {
      x: record.positionX,
      y: record.positionY,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toBookNodeEdge(record: typeof storyNodeEdges.$inferSelect): BookNodeEdge {
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
    weight: record.weight,
    isDirected: record.isDirected ?? true,
    style,
    controlPointOffset: cp,
    sourceAnchor: sa,
    targetAnchor: ta,
    createdAt: record.createdAt,
  };
}

export function createBookNodeSqliteRepository(defaultProjectId: string): BookNodeRepository {
  return {
    async findById(id: string) {
      const rows = await getDb().select().from(storyNodes).where(eq(storyNodes.id, id)).limit(1);
      return rows[0] ? toBookNode(rows[0]) : null;
    },

    async findAll(projectId?: string) {
      const pid = projectId ?? defaultProjectId;
      const rows = await getDb().select().from(storyNodes)
        .where(eq(storyNodes.projectId, pid))
        .orderBy(asc(storyNodes.start));
      return rows.map(toBookNode);
    },

    async create(data: CreateBookNodeRepoInput) {
      const now = new Date().toISOString();
      const id = data.id ?? uuidv7();

      // Validate Project Exists to prevent vague FK errors
      const validProjectId = data.projectId;
      if (!validProjectId) throw new Error("Project ID is missing for node creation");

      const projectExists = await getDb().select({ id: projects.id }).from(projects).where(eq(projects.id, validProjectId)).limit(1);
      if (projectExists.length === 0) {
        throw new Error(`Project with ID ${validProjectId} does not exist. Cannot create node.`);
      }

      const newNode: typeof storyNodes.$inferInsert = {
        id,
        projectId: validProjectId,
        title: data.title,
        start: data.start,
        end: data.end,
        summary: data.summary,
        // Ensure empty string becomes null to satisfy FK 
        storyStageId: data.storyStageId || null,
        positionX: data.position.x,
        positionY: data.position.y,
        createdAt: data.createdAt ?? now,
        updatedAt: data.updatedAt ?? now,
      };

      await getDb().insert(storyNodes).values(newNode);

      return toBookNode({
        ...newNode,
        positionX: newNode.positionX!,
        positionY: newNode.positionY!,
      } as typeof storyNodes.$inferSelect);
    },

    async update(id: string, updates: BookNodeUpdateData) {
      const existing = await getDb().select().from(storyNodes).where(eq(storyNodes.id, id)).limit(1);
      if (!existing[0]) return null;

      const now = new Date().toISOString();
      const updateValues: Partial<typeof storyNodes.$inferInsert> = {
        updatedAt: updates.updatedAt ?? now,
      };

      if (updates.title !== undefined) updateValues.title = updates.title;
      if (updates.start !== undefined) updateValues.start = updates.start;
      if (updates.end !== undefined) updateValues.end = updates.end;
      if (updates.summary !== undefined) updateValues.summary = updates.summary;
      if (updates.storyStageId !== undefined) updateValues.storyStageId = updates.storyStageId;
      if (updates.projectId !== undefined) updateValues.projectId = updates.projectId;

      if (updates.position) {
        if (updates.position.x !== undefined && updates.position.x !== null) updateValues.positionX = updates.position.x;
        if (updates.position.y !== undefined && updates.position.y !== null) updateValues.positionY = updates.position.y;
      }

      await getDb().update(storyNodes).set(updateValues).where(eq(storyNodes.id, id));

      // Fetch updated
      const updated = await getDb().select().from(storyNodes).where(eq(storyNodes.id, id)).limit(1);
      return updated[0] ? toBookNode(updated[0]) : null;
    },

    async delete(id: string) {
      const result = await getDb().delete(storyNodes).where(eq(storyNodes.id, id));
      return (result as any).rowsAffected > 0;
    },

    async swapOrder(first: BookNode, second: BookNode) {
      const now = new Date().toISOString();

      await getDb().transaction(async (tx) => {
        await tx.update(storyNodes)
          .set({ start: second.start, updatedAt: now })
          .where(eq(storyNodes.id, first.id));

        await tx.update(storyNodes)
          .set({ start: first.start, updatedAt: now })
          .where(eq(storyNodes.id, second.id));
      });
    },
  };
}

export function createBookNodeEdgeSqliteRepository(defaultProjectId: string): BookNodeEdgeRepository {
  return {
    async findAll(projectId?: string) {
      const pid = projectId ?? defaultProjectId;
      const rows = await getDb().select().from(storyNodeEdges)
        .where(eq(storyNodeEdges.projectId, pid))
        .orderBy(asc(storyNodeEdges.createdAt));
      return rows.map(toBookNodeEdge);
    },

    async create(input: CreateBookNodeEdgeInput) {
      const now = new Date().toISOString();
      const id = uuidv7();

      const newEdge: typeof storyNodeEdges.$inferInsert = {
        id,
        projectId: input.projectId ?? defaultProjectId,
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
        label: input.label,
        weight: input.weight ?? 1,
        isDirected: true, // Default
        styleJson: input.style ? JSON.stringify(input.style) : undefined,
        controlPointOffsetJson: input.controlPointOffset ? JSON.stringify(input.controlPointOffset) : undefined,
        sourceAnchorJson: input.sourceAnchor ? JSON.stringify(input.sourceAnchor) : undefined,
        targetAnchorJson: input.targetAnchor ? JSON.stringify(input.targetAnchor) : undefined,
        createdAt: now,
      };

      await getDb().insert(storyNodeEdges).values(newEdge);
      return toBookNodeEdge(newEdge as any);
    },

    async update(id: string, updates: BookNodeEdgeUpdateData) {
      const updateValues: any = {};
      if (updates.label !== undefined) updateValues.label = updates.label;
      if (updates.weight !== undefined) updateValues.weight = updates.weight;
      if (updates.style) updateValues.styleJson = JSON.stringify(updates.style);

      if (Object.keys(updateValues).length > 0) {
        await getDb().update(storyNodeEdges).set(updateValues).where(eq(storyNodeEdges.id, id));
      }

      const res = await getDb().select().from(storyNodeEdges).where(eq(storyNodeEdges.id, id));
      return res[0] ? toBookNodeEdge(res[0]) : null;
    },

    async delete(id: string) {
      await getDb().delete(storyNodeEdges).where(eq(storyNodeEdges.id, id));
      return true;
    },
  };
}

// placeholders
export async function markNodeSyncStatus(id: string, status: any, options?: any) { }
export async function applyRemoteNode(node: BookNode) { return 'skipped'; }
export async function cleanupSyncedDeletedNodes() { }

