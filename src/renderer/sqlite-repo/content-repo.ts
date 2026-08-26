import { getDb, type DbExecutor } from '../lib/db';
import { BookNodeTable, NodeContentTable } from '../schema/drizzle';
import { and, eq } from 'drizzle-orm';
import type { NodeContent } from '../domain/node-content';

export type CreateBookContentInput = {
  nodeId: string;
  contentJson?: string;
  outlineJson?: string;
};

export type BookContentUpdateData = Partial<Omit<NodeContent, 'plotGridJson'>>;

export interface BookContentRepository {
  findById(id: string): Promise<NodeContent | null>;
  findByNodeId(nodeId: string): Promise<NodeContent | null>;
  /** Every content row whose node belongs to the project, in one query. */
  listByProject(projectId: string): Promise<NodeContent[]>;
  create(input: CreateBookContentInput): Promise<NodeContent>;
  update(id: string, data: BookContentUpdateData): Promise<NodeContent | null>;
  updateByNodeId(nodeId: string, data: BookContentUpdateData): Promise<NodeContent | null>;
  materializePlotGridProjection(
    nodeId: string,
    plotGridJson: string,
  ): Promise<NodeContent | null>;
  deleteById(id: string): Promise<boolean>;
  deleteByNodeId(nodeId: string): Promise<boolean>;
}

function toNodeContent(record: typeof NodeContentTable.$inferSelect): NodeContent {
  return {
    nodeId: record.nodeId,
    contentJson: record.contentJson ?? '{}',
    outlineJson: record.outlineJson ?? '[]',
    plotGridJson: record.plotGridJson ?? '{}',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createBookContentRepository(
  dbOverride?: DbExecutor,
  projectId?: string,
): BookContentRepository {
  const dbProvider = () => dbOverride ?? getDb();
  const nodeBelongsToProject = async (nodeId: string): Promise<boolean> => {
    if (!projectId) return true;
    const rows = await dbProvider()
      .select({ id: BookNodeTable.id })
      .from(BookNodeTable)
      .where(and(eq(BookNodeTable.id, nodeId), eq(BookNodeTable.projectId, projectId)))
      .limit(1);
    return Boolean(rows[0]);
  };
  const findById = async (id: string): Promise<NodeContent | null> => {
    return findByNodeId(id);
  };

  const findByNodeId = async (nodeId: string): Promise<NodeContent | null> => {
    if (!(await nodeBelongsToProject(nodeId))) return null;
    const rows = await dbProvider()
      .select()
      .from(NodeContentTable)
      .where(eq(NodeContentTable.nodeId, nodeId))
      .limit(1);
    return rows[0] ? toNodeContent(rows[0]) : null;
  };

  const listByProject = async (targetProjectId: string): Promise<NodeContent[]> => {
    if (projectId && targetProjectId !== projectId) return [];
    const rows = await dbProvider()
      .select({ content: NodeContentTable })
      .from(NodeContentTable)
      .innerJoin(BookNodeTable, eq(BookNodeTable.id, NodeContentTable.nodeId))
      .where(eq(BookNodeTable.projectId, targetProjectId));
    return rows.map((row) => toNodeContent(row.content));
  };

  const create = async (input: CreateBookContentInput): Promise<NodeContent> => {
    if (!(await nodeBelongsToProject(input.nodeId))) {
      throw new Error(`Cannot create node content outside project ${projectId}`);
    }
    const now = new Date().toISOString();

    const newContent: typeof NodeContentTable.$inferInsert = {
      nodeId: input.nodeId,
      contentJson: input.contentJson ?? '{}',
      outlineJson: input.outlineJson ?? '[]',
      plotGridJson: '{}',
      createdAt: now,
      updatedAt: now,
    };

    await dbProvider().insert(NodeContentTable).values(newContent);
    return toNodeContent(newContent as typeof NodeContentTable.$inferSelect);
  };

  const update = async (id: string, data: BookContentUpdateData): Promise<NodeContent | null> => {
    if (!(await nodeBelongsToProject(id))) return null;
    if (data.nodeId && !(await nodeBelongsToProject(data.nodeId))) {
      throw new Error(`Cannot move node content outside project ${projectId}`);
    }
    const now = new Date().toISOString();
    const updateValues: Partial<typeof NodeContentTable.$inferInsert> = {
      updatedAt: now,
    };

    if (data.nodeId) updateValues.nodeId = data.nodeId;
    if (data.contentJson !== undefined) updateValues.contentJson = data.contentJson;
    if (data.outlineJson !== undefined) updateValues.outlineJson = data.outlineJson;

    await dbProvider()
      .update(NodeContentTable)
      .set(updateValues)
      .where(eq(NodeContentTable.nodeId, id));

    return findById(id);
  };

  const updateByNodeId = async (
    nodeId: string,
    data: BookContentUpdateData,
  ): Promise<NodeContent | null> => {
    const existing = await findByNodeId(nodeId);
    if (!existing) return null;
    return update(nodeId, data);
  };

  const materializePlotGridProjection = async (
    nodeId: string,
    plotGridJson: string,
  ): Promise<NodeContent | null> => {
    if (!(await nodeBelongsToProject(nodeId))) return null;
    await dbProvider()
      .update(NodeContentTable)
      .set({ plotGridJson, updatedAt: new Date().toISOString() })
      .where(eq(NodeContentTable.nodeId, nodeId));
    return findByNodeId(nodeId);
  };

  const deleteById = async (id: string): Promise<boolean> => {
    if (!(await nodeBelongsToProject(id))) return false;
    const result = await dbProvider()
      .delete(NodeContentTable)
      .where(eq(NodeContentTable.nodeId, id));
    return (result as { rowsAffected: number }).rowsAffected > 0;
  };

  const deleteByNodeId = async (nodeId: string): Promise<boolean> => {
    if (!(await nodeBelongsToProject(nodeId))) return false;
    const result = await dbProvider()
      .delete(NodeContentTable)
      .where(eq(NodeContentTable.nodeId, nodeId));
    return (result as { rowsAffected: number }).rowsAffected > 0;
  };

  return {
    findById,
    findByNodeId,
    listByProject,
    create,
    update,
    updateByNodeId,
    materializePlotGridProjection,
    deleteById,
    deleteByNodeId,
  };
}

// Sync related functions (placeholders)
export async function markContentSyncStatus() {}
export async function applyRemoteContent() {
  return 'skipped';
}
export async function cleanupSyncedDeletedContents() {}
