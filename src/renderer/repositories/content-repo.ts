import { getDb } from '../lib/db';
import { nodeContents } from '../schema/drizzle';
import { eq, desc } from 'drizzle-orm';
import type { NodeContent } from '../domain/node-content';
import { v7 as uuidv7 } from 'uuid';



export type CreateBookContentInput = {
  nodeId: string;
  projectId: string;
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


function toNodeContent(record: typeof nodeContents.$inferSelect): NodeContent {
  return {
    id: record.id,
    nodeId: record.nodeId,
    projectId: record.projectId,
    contentJson: record.contentJson ?? '{}',
    outlineJson: record.outlineJson ?? '[]',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createBookContentRepository(): BookContentRepository {

  const findById = async (id: string): Promise<NodeContent | null> => {
    const rows = await getDb().select().from(nodeContents).where(eq(nodeContents.id, id)).limit(1);
    return rows[0] ? toNodeContent(rows[0]) : null;
  };

  const findByNodeId = async (nodeId: string): Promise<NodeContent | null> => {
    const rows = await getDb().select().from(nodeContents).where(eq(nodeContents.nodeId, nodeId)).limit(1);
    return rows[0] ? toNodeContent(rows[0]) : null;
  };

  const create = async (input: CreateBookContentInput): Promise<NodeContent> => {
    const now = new Date().toISOString();
    const id = uuidv7();

    const newContent: typeof nodeContents.$inferInsert = {
      id,
      nodeId: input.nodeId,
      projectId: input.projectId,
      contentJson: input.contentJson ?? '{}',
      outlineJson: input.outlineJson ?? '[]',
      createdAt: now,
      updatedAt: now,
    };

    await getDb().insert(nodeContents).values(newContent);
    return toNodeContent(newContent as typeof nodeContents.$inferSelect);
  }

  const update = async (id: string, data: Partial<NodeContent>): Promise<NodeContent | null> => {
    const existing = await findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updateValues: Partial<typeof nodeContents.$inferInsert> = {
      updatedAt: now,
    };

    if (data.nodeId) updateValues.nodeId = data.nodeId;
    if (data.projectId) updateValues.projectId = data.projectId;
    if (data.contentJson !== undefined) updateValues.contentJson = data.contentJson;
    if (data.outlineJson !== undefined) updateValues.outlineJson = data.outlineJson;

    await getDb().update(nodeContents)
      .set(updateValues)
      .where(eq(nodeContents.id, id));

    return findById(id);
  }

  const updateByNodeId = async (nodeId: string, data: Partial<NodeContent>): Promise<NodeContent | null> => {
    const existing = await findByNodeId(nodeId);
    if (!existing) return null;
    return update(existing.id, data);
  }

  const deleteById = async (id: string): Promise<boolean> => {
    const result = await getDb().delete(nodeContents).where(eq(nodeContents.id, id));
    return (result as any).rowsAffected > 0;
  }

  const deleteByNodeId = async (nodeId: string): Promise<boolean> => {
    const result = await getDb().delete(nodeContents).where(eq(nodeContents.nodeId, nodeId));
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