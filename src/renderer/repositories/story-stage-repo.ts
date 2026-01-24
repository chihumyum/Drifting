import { getDb } from '../lib/db';
import { StoryStageTable, NodeTagTable, NodeTagLinkTable } from '../schema/drizzle';
import { eq, asc, and } from 'drizzle-orm';
import type { NodeTag, NodeTagLink } from '../domain/node-tag';
import type { StoryStage } from '../domain/storystage';
import { v7 as uuidv7 } from 'uuid';

const nodeTagsLink = NodeTagLinkTable;

// Story Stage Repository
export interface StoryStageRepository {
  findById(id: string): Promise<StoryStage | null>;
  findAll(projectId: string): Promise<StoryStage[]>;
  create(data: Omit<StoryStage, 'id' | 'createdAt' | 'updatedAt'>): Promise<StoryStage>;
  update(id: string, data: Partial<StoryStage>): Promise<StoryStage | null>;
  delete(id: string): Promise<boolean>;
}

// Node Tag Repository
export interface NodeTagRepository {
  findById(id: string): Promise<NodeTag | null>;
  findAll(projectId: string): Promise<NodeTag[]>;
  findByName(projectId: string, name: string): Promise<NodeTag | null>;
  create(data: Omit<NodeTag, 'id' | 'createdAt' | 'updatedAt'>): Promise<NodeTag>;
  delete(id: string): Promise<boolean>;
}

// Node Tag Link Repository (for many-to-many relationship)
export interface NodeTagLinkRepository {
  // Get all tags for a node
  findTagsByNodeId(nodeId: string): Promise<NodeTag[]>;
  // Get all nodes with a specific tag
  findNodeIdsByTagId(tagId: string): Promise<string[]>;
  // Link a tag to a node
  addTagToNode(nodeId: string, tagId: string): Promise<NodeTagLink>;
  // Remove a tag from a node
  removeTagFromNode(nodeId: string, tagId: string): Promise<boolean>;
  // Remove all tags from a node
  removeAllTagsFromNode(nodeId: string): Promise<boolean>;
}


// ==================== Converters ====================

function storyStageRecordToDomain(record: typeof StoryStageTable.$inferSelect): StoryStage {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    descriptionJson: record.descriptionJson ?? '{}',
    orderKey: record.orderKey,
    color: record.color,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function nodeTagRecordToDomain(record: typeof NodeTagTable.$inferSelect): NodeTag {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    color: record.color,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// ==================== Story Stage Repository ====================

export function createStoryStageRepository(): StoryStageRepository {

  const findById = async (id: string): Promise<StoryStage | null> => {
    const rows = await getDb().select().from(StoryStageTable).where(eq(StoryStageTable.id, id)).limit(1);
    return rows[0] ? storyStageRecordToDomain(rows[0]) : null;
  };

  const findAll = async (projectId: string): Promise<StoryStage[]> => {
    const rows = await getDb().select().from(StoryStageTable)
      .where(eq(StoryStageTable.projectId, projectId))
      .orderBy(asc(StoryStageTable.orderKey));
    return rows.map(storyStageRecordToDomain);
  };

  const create = async (data: any): Promise<StoryStage> => {
    const now = new Date().toISOString();
    const id = uuidv7();
    const newStage: typeof StoryStageTable.$inferInsert = {
      id,
      projectId: data.projectId,
      name: data.name,
      descriptionJson: data.descriptionJson ?? '{}',
      orderKey: data.orderKey ?? 0,
      color: data.color ?? '#000000',
      createdAt: now,
      updatedAt: now,
    };

    await getDb().insert(StoryStageTable).values(newStage);

    return storyStageRecordToDomain(newStage as typeof StoryStageTable.$inferSelect);
  };

  const update = async (id: string, data: any): Promise<StoryStage | null> => {
    const existing = await findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updateValues: Partial<typeof StoryStageTable.$inferInsert> = {
      updatedAt: now,
    };

    if (data.name !== undefined) updateValues.name = data.name;
    if (data.descriptionJson !== undefined) {
      updateValues.descriptionJson = typeof data.descriptionJson === 'string'
        ? data.descriptionJson
        : JSON.stringify(data.descriptionJson);
    }
    if (data.orderKey !== undefined) updateValues.orderKey = data.orderKey;
    if (data.color !== undefined) updateValues.color = data.color;

    await getDb().update(StoryStageTable).set(updateValues).where(eq(StoryStageTable.id, id));

    return findById(id);
  };

  const deleteStage = async (id: string): Promise<boolean> => {
    const result = await getDb().delete(StoryStageTable).where(eq(StoryStageTable.id, id));
    return (result as any).rowsAffected > 0; // rowsAffected might not be typed in Drizzle proxy result properly, relying on loose typing
  };

  return {
    findById,
    findAll,
    create,
    update,
    delete: deleteStage,
  };
}

// ==================== Node Tag Repository ====================

export function createNodeTagRepository(): NodeTagRepository {

  const findById = async (id: string): Promise<NodeTag | null> => {
    const rows = await getDb().select().from(NodeTagTable).where(eq(NodeTagTable.id, id)).limit(1);
    return rows[0] ? nodeTagRecordToDomain(rows[0]) : null;
  };

  const findAll = async (projectId: string): Promise<NodeTag[]> => {
    const rows = await getDb().select().from(NodeTagTable)
      .where(eq(NodeTagTable.projectId, projectId))
      .orderBy(asc(NodeTagTable.name));
    return rows.map(nodeTagRecordToDomain);
  };

  const findByName = async (projectId: string, name: string): Promise<NodeTag | null> => {
    const rows = await getDb().select().from(NodeTagTable)
      .where(and(eq(NodeTagTable.projectId, projectId), eq(NodeTagTable.name, name)))
      .limit(1);
    return rows[0] ? nodeTagRecordToDomain(rows[0]) : null;
  };

  const create = async (data: any): Promise<NodeTag> => {
    const now = new Date().toISOString();
    const id = uuidv7();
    const newTag: typeof NodeTagTable.$inferInsert = {
      id,
      projectId: data.projectId,
      name: data.name,
      color: data.color ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await getDb().insert(NodeTagTable).values(newTag);
    return nodeTagRecordToDomain(newTag as typeof NodeTagTable.$inferSelect);
  };

  const deleteTag = async (id: string): Promise<boolean> => {
    const result = await getDb().delete(NodeTagTable).where(eq(NodeTagTable.id, id));
    return (result as any).rowsAffected > 0;
  };

  return {
    findById,
    findAll,
    findByName,
    create,
    delete: deleteTag,
  };
}

// ==================== Node Tag Link Repository ====================

export function createNodeTagLinkRepository(): NodeTagLinkRepository {
  const findTagsByNodeId = async (nodeId: string): Promise<NodeTag[]> => {
    const rows = await getDb().select({
      id: NodeTagTable.id,
      projectId: NodeTagTable.projectId,
      name: NodeTagTable.name,
      color: NodeTagTable.color,
      createdAt: NodeTagTable.createdAt,
      updatedAt: NodeTagTable.updatedAt
    })
      .from(NodeTagTable)
      .innerJoin(nodeTagsLink, eq(NodeTagTable.id, nodeTagsLink.tagId))
      .where(eq(nodeTagsLink.nodeId, nodeId))
      .orderBy(asc(NodeTagTable.name));

    return rows.map(nodeTagRecordToDomain);
  };

  const findNodeIdsByTagId = async (tagId: string): Promise<string[]> => {
    const rows = await getDb().select({ nodeId: nodeTagsLink.nodeId })
      .from(nodeTagsLink)
      .where(eq(nodeTagsLink.tagId, tagId));
    return rows.map(r => r.nodeId);
  };

  const addTagToNode = async (nodeId: string, tagId: string): Promise<NodeTagLink> => {
    await getDb().insert(nodeTagsLink)
      .values({ nodeId, tagId })
      .onConflictDoNothing();

    return { nodeId, tagId };
  };

  const removeTagFromNode = async (nodeId: string, tagId: string): Promise<boolean> => {
    const result = await getDb().delete(nodeTagsLink)
      .where(and(eq(nodeTagsLink.nodeId, nodeId), eq(nodeTagsLink.tagId, tagId)));
    return (result as any).rowsAffected > 0;
  };

  const removeAllTagsFromNode = async (nodeId: string): Promise<boolean> => {
    const result = await getDb().delete(nodeTagsLink)
      .where(eq(nodeTagsLink.nodeId, nodeId));
    return (result as any).rowsAffected > 0;
  };

  return {
    findTagsByNodeId,
    findNodeIdsByTagId,
    addTagToNode,
    removeTagFromNode,
    removeAllTagsFromNode,
  };
}
