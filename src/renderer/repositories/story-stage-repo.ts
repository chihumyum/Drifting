import { getDb } from '../lib/db';
import { storyStages, nodeTags, nodeTagsLink } from '../schema/drizzle';
import { eq, asc, and } from 'drizzle-orm';
import type { NodeTag, NodeTagLink } from '../domain/node-tag';
import type { StoryStage } from '../domain/storystage';
import { v7 as uuidv7 } from 'uuid';

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
  create(data: Omit<NodeTag, 'id' | 'createdAt'>): Promise<NodeTag>;
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

function storyStageRecordToDomain(record: typeof storyStages.$inferSelect): StoryStage {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    descriptionJson: record.descriptionJson ?? '{}',
    orderKey: record.orderKey,
    startNodeId: record.startNodeId ?? '',
    endNodeId: record.endNodeId ?? '',
    color: record.color,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function nodeTagRecordToDomain(record: typeof nodeTags.$inferSelect): NodeTag {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    color: record.color,
    createdAt: record.createdAt,
  };
}

// ==================== Story Stage Repository ====================

export function createStoryStageRepository(): StoryStageRepository {

  const findById = async (id: string): Promise<StoryStage | null> => {
    const rows = await getDb().select().from(storyStages).where(eq(storyStages.id, id)).limit(1);
    return rows[0] ? storyStageRecordToDomain(rows[0]) : null;
  };

  const findAll = async (projectId: string): Promise<StoryStage[]> => {
    const rows = await getDb().select().from(storyStages)
      .where(eq(storyStages.projectId, projectId))
      .orderBy(asc(storyStages.orderKey));
    return rows.map(storyStageRecordToDomain);
  };

  const create = async (data: any): Promise<StoryStage> => {
    const now = new Date().toISOString();
    const id = uuidv7();
    const newStage: typeof storyStages.$inferInsert = {
      id,
      projectId: data.projectId,
      name: data.name,
      descriptionJson: data.description ?? '{}',
      orderKey: data.orderKey ?? 0,
      color: data.color ?? '#000000',
      createdAt: now,
      updatedAt: now,
    };

    await getDb().insert(storyStages).values(newStage);

    return storyStageRecordToDomain(newStage as typeof storyStages.$inferSelect);
  };

  const update = async (id: string, data: any): Promise<StoryStage | null> => {
    const existing = await findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updateValues: Partial<typeof storyStages.$inferInsert> = {
      updatedAt: now,
    };

    if (data.name !== undefined) updateValues.name = data.name;
    if (data.description !== undefined) updateValues.descriptionJson = typeof data.description === 'string' ? data.description : JSON.stringify(data.description);
    if (data.orderKey !== undefined) updateValues.orderKey = data.orderKey;
    if (data.color !== undefined) updateValues.color = data.color;

    await getDb().update(storyStages).set(updateValues).where(eq(storyStages.id, id));

    return findById(id);
  };

  const deleteStage = async (id: string): Promise<boolean> => {
    const result = await getDb().delete(storyStages).where(eq(storyStages.id, id));
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
    const rows = await getDb().select().from(nodeTags).where(eq(nodeTags.id, id)).limit(1);
    return rows[0] ? nodeTagRecordToDomain(rows[0]) : null;
  };

  const findAll = async (projectId: string): Promise<NodeTag[]> => {
    const rows = await getDb().select().from(nodeTags)
      .where(eq(nodeTags.projectId, projectId))
      .orderBy(asc(nodeTags.name));
    return rows.map(nodeTagRecordToDomain);
  };

  const findByName = async (projectId: string, name: string): Promise<NodeTag | null> => {
    const rows = await getDb().select().from(nodeTags)
      .where(and(eq(nodeTags.projectId, projectId), eq(nodeTags.name, name)))
      .limit(1);
    return rows[0] ? nodeTagRecordToDomain(rows[0]) : null;
  };

  const create = async (data: any): Promise<NodeTag> => {
    const now = new Date().toISOString();
    const id = uuidv7();
    const newTag: typeof nodeTags.$inferInsert = {
      id,
      projectId: data.projectId,
      name: data.name,
      color: data.color ?? null,
      createdAt: now,
    };

    await getDb().insert(nodeTags).values(newTag);
    return nodeTagRecordToDomain(newTag as typeof nodeTags.$inferSelect);
  };

  const deleteTag = async (id: string): Promise<boolean> => {
    const result = await getDb().delete(nodeTags).where(eq(nodeTags.id, id));
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
      id: nodeTags.id,
      projectId: nodeTags.projectId,
      name: nodeTags.name,
      color: nodeTags.color,
      createdAt: nodeTags.createdAt
    })
      .from(nodeTags)
      .innerJoin(nodeTagsLink, eq(nodeTags.id, nodeTagsLink.tagId))
      .where(eq(nodeTagsLink.nodeId, nodeId))
      .orderBy(asc(nodeTags.name));

    return rows.map(nodeTagRecordToDomain);
  };

  const findNodeIdsByTagId = async (tagId: string): Promise<string[]> => {
    const rows = await getDb().select({ nodeId: nodeTagsLink.nodeId })
      .from(nodeTagsLink)
      .where(eq(nodeTagsLink.tagId, tagId));
    return rows.map(r => r.nodeId);
  };

  const addTagToNode = async (nodeId: string, tagId: string): Promise<NodeTagLink> => {
    const now = new Date().toISOString();
    await getDb().insert(nodeTagsLink)
      .values({ nodeId, tagId, createdAt: now })
      .onConflictDoNothing();

    return { nodeId, tagId, createdAt: now };
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
