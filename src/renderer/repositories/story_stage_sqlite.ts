// SQLite implementation for Story Stage and Node Tag repositories
import { v7 as uuidv7 } from 'uuid';
import { run, query } from '../lib/db';
import type { StoryStage, NodeTag, NodeTagLink } from '../domain/node-tag';
import type { 
  StoryStageRecord, 
  NodeTagRecord,
} from '../schema/book_general';
import type { 
  StoryStageRepository, 
  NodeTagRepository, 
  NodeTagLinkRepository 
} from './story_stage';

// ==================== Converters ====================

function storyStageRecordToDomain(record: StoryStageRecord): StoryStage {
  return {
    id: record.id,
    projectId: record.project_id,
    name: record.name,
    description: record.description,
    orderKey: record.order_key,
    color: record.color,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function storyStageToRecord(stage: StoryStage): StoryStageRecord {
  return {
    id: stage.id,
    project_id: stage.projectId,
    name: stage.name,
    description: stage.description,
    order_key: stage.orderKey,
    color: stage.color,
    created_at: stage.createdAt,
    updated_at: stage.updatedAt,
  };
}

function nodeTagRecordToDomain(record: NodeTagRecord): NodeTag {
  return {
    id: record.id,
    projectId: record.project_id,
    name: record.name,
    color: record.color,
    createdAt: record.created_at,
  };
}

function nodeTagToRecord(tag: NodeTag): NodeTagRecord {
  return {
    id: tag.id,
    project_id: tag.projectId,
    name: tag.name,
    color: tag.color,
    created_at: tag.createdAt,
  };
}

// ==================== Story Stage Repository ====================

export function createStoryStageRepository(): StoryStageRepository {
  const selectBase = `SELECT * FROM story_stage`;

  const findById = async (id: string): Promise<StoryStage | null> => {
    const result = await query<StoryStageRecord>(`${selectBase} WHERE id = ?`, [id]);
    return result.length ? storyStageRecordToDomain(result[0]) : null;
  };

  const findAll = async (projectId: string): Promise<StoryStage[]> => {
    const result = await query<StoryStageRecord>(
      `${selectBase} WHERE project_id = ? ORDER BY order_key ASC`,
      [projectId]
    );
    return result.map(storyStageRecordToDomain);
  };

  const create = async (data: Omit<StoryStage, 'id' | 'createdAt' | 'updatedAt'>): Promise<StoryStage> => {
    const now = new Date().toISOString();
    const id = uuidv7();
    const stage: StoryStage = {
      id,
      ...data,
      createdAt: now,
      updatedAt: now,
    };
    const record = storyStageToRecord(stage);
    
    await run(
      `INSERT INTO story_stage (id, project_id, name, description, order_key, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.project_id, record.name, record.description, record.order_key, record.color, record.created_at, record.updated_at]
    );
    
    return stage;
  };

  const update = async (id: string, data: Partial<StoryStage>): Promise<StoryStage | null> => {
    const existing = await findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updated: StoryStage = {
      ...existing,
      ...data,
      id, // Ensure id doesn't change
      updatedAt: now,
    };
    const record = storyStageToRecord(updated);

    await run(
      `UPDATE story_stage 
       SET project_id = ?, name = ?, description = ?, order_key = ?, color = ?, updated_at = ?
       WHERE id = ?`,
      [record.project_id, record.name, record.description, record.order_key, record.color, record.updated_at, record.id]
    );

    return updated;
  };

  const deleteStage = async (id: string): Promise<boolean> => {
    const changes = await run(`DELETE FROM story_stage WHERE id = ?`, [id]);
    return changes > 0;
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
  const selectBase = `SELECT * FROM node_tag`;

  const findById = async (id: string): Promise<NodeTag | null> => {
    const result = await query<NodeTagRecord>(`${selectBase} WHERE id = ?`, [id]);
    return result.length ? nodeTagRecordToDomain(result[0]) : null;
  };

  const findAll = async (projectId: string): Promise<NodeTag[]> => {
    const result = await query<NodeTagRecord>(
      `${selectBase} WHERE project_id = ? ORDER BY name ASC`,
      [projectId]
    );
    return result.map(nodeTagRecordToDomain);
  };

  const findByName = async (projectId: string, name: string): Promise<NodeTag | null> => {
    const result = await query<NodeTagRecord>(
      `${selectBase} WHERE project_id = ? AND name = ?`,
      [projectId, name]
    );
    return result.length ? nodeTagRecordToDomain(result[0]) : null;
  };

  const create = async (data: Omit<NodeTag, 'id' | 'createdAt'>): Promise<NodeTag> => {
    const now = new Date().toISOString();
    const id = uuidv7();
    const tag: NodeTag = {
      id,
      ...data,
      createdAt: now,
    };
    const record = nodeTagToRecord(tag);

    await run(
      `INSERT INTO node_tag (id, project_id, name, color, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [record.id, record.project_id, record.name, record.color, record.created_at]
    );

    return tag;
  };

  const deleteTag = async (id: string): Promise<boolean> => {
    const changes = await run(`DELETE FROM node_tag WHERE id = ?`, [id]);
    return changes > 0;
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
    const result = await query<NodeTagRecord>(
      `SELECT nt.* FROM node_tag nt
       INNER JOIN node_tag_link ntl ON nt.id = ntl.tag_id
       WHERE ntl.node_id = ?
       ORDER BY nt.name ASC`,
      [nodeId]
    );
    return result.map(nodeTagRecordToDomain);
  };

  const findNodeIdsByTagId = async (tagId: string): Promise<string[]> => {
    const result = await query<{ node_id: string }>(
      `SELECT node_id FROM node_tag_link WHERE tag_id = ?`,
      [tagId]
    );
    return result.map(r => r.node_id);
  };

  const addTagToNode = async (nodeId: string, tagId: string): Promise<NodeTagLink> => {
    const now = new Date().toISOString();
    const link: NodeTagLink = {
      nodeId,
      tagId,
      createdAt: now,
    };

    await run(
      `INSERT OR IGNORE INTO node_tag_link (node_id, tag_id, created_at)
       VALUES (?, ?, ?)`,
      [nodeId, tagId, now]
    );

    return link;
  };

  const removeTagFromNode = async (nodeId: string, tagId: string): Promise<boolean> => {
    const changes = await run(
      `DELETE FROM node_tag_link WHERE node_id = ? AND tag_id = ?`,
      [nodeId, tagId]
    );
    return changes > 0;
  };

  const removeAllTagsFromNode = async (nodeId: string): Promise<boolean> => {
    const changes = await run(
      `DELETE FROM node_tag_link WHERE node_id = ?`,
      [nodeId]
    );
    return changes > 0;
  };

  return {
    findTagsByNodeId,
    findNodeIdsByTagId,
    addTagToNode,
    removeTagFromNode,
    removeAllTagsFromNode,
  };
}
