import { getDb } from '../lib/db';
import { NodeContentTable } from '../schema/drizzle';
import { eq } from 'drizzle-orm';
import type { NodeContent } from '../domain/node-content';



export type CreateBookContentInput = {
  nodeId: string;
  contentJson?: string;
  outlineJson?: string;
};

export interface BookContentRepository {
  findById(id: string): Promise<NodeContent | null>;
  findByNodeId(nodeId: string): Promise<NodeContent | null>;
  create(input: CreateBookContentInput): Promise<NodeContent>;
  update(contentId: string, data: Partial<NodeContent>): Promise<NodeContent | null>;
  updateByNodeId(nodeId: string, data: Partial<NodeContent>): Promise<NodeContent | null>;
  deleteById(id: string): Promise<boolean>;
  deleteByNodeId(nodeId: string): Promise<boolean>;
}


function toNodeContent(record: typeof NodeContentTable.$inferSelect): NodeContent {
  return {
    nodeId: record.nodeId,
    contentJson: record.contentJson ?? '{}',
    outlineJson: record.outlineJson ?? '[]',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createBookContentRepository(): BookContentRepository {

  const findById = async (id: string): Promise<NodeContent | null> => {
    return findByNodeId(id);
  };

  const findByNodeId = async (nodeId: string): Promise<NodeContent | null> => {
    const rows = await getDb().select().from(NodeContentTable).where(eq(NodeContentTable.nodeId, nodeId)).limit(1);
    return rows[0] ? toNodeContent(rows[0]) : null;
  };

  const create = async (input: CreateBookContentInput): Promise<NodeContent> => {
    const now = new Date().toISOString();

    const newContent: typeof NodeContentTable.$inferInsert = {
      nodeId: input.nodeId,
      contentJson: input.contentJson ?? '{}',
      outlineJson: input.outlineJson ?? '[]',
      createdAt: now,
      updatedAt: now,
    };

    await getDb().insert(NodeContentTable).values(newContent);
    return toNodeContent(newContent as typeof NodeContentTable.$inferSelect);
  }

  const update = async (id: string, data: Partial<NodeContent>): Promise<NodeContent | null> => {
    const now = new Date().toISOString();
    const updateValues: Partial<typeof NodeContentTable.$inferInsert> = {
      updatedAt: now,
    };

    if (data.nodeId) updateValues.nodeId = data.nodeId;
    if (data.contentJson !== undefined) updateValues.contentJson = data.contentJson;
    if (data.outlineJson !== undefined) updateValues.outlineJson = data.outlineJson;

    await getDb().update(NodeContentTable)
      .set(updateValues)
      .where(eq(NodeContentTable.nodeId, id));

    return findById(id);
  }

  const updateByNodeId = async (nodeId: string, data: Partial<NodeContent>): Promise<NodeContent | null> => {
    const existing = await findByNodeId(nodeId);
    if (!existing) return null;
    return update(nodeId, data);
  }

  const deleteById = async (id: string): Promise<boolean> => {
    const result = await getDb().delete(NodeContentTable).where(eq(NodeContentTable.nodeId, id));
    return (result as any).rowsAffected > 0;
  }

  const deleteByNodeId = async (nodeId: string): Promise<boolean> => {
    const result = await getDb().delete(NodeContentTable).where(eq(NodeContentTable.nodeId, nodeId));
    return (result as any).rowsAffected > 0;
  }

  return {
    findById,
    findByNodeId,
    create,
    update,
    updateByNodeId,
    deleteById,
    deleteByNodeId,
  };
}


// Sync related functions (placeholders)
export async function markContentSyncStatus() { }
export async function applyRemoteContent() { return 'skipped'; }
export async function cleanupSyncedDeletedContents() { }
