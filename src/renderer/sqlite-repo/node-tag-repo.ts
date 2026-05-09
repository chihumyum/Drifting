import { getDb, type DbExecutor } from '../lib/db';
import { NodeTagTable, NodeTagLinkTable } from '../schema/drizzle';
import { eq, asc, and } from 'drizzle-orm';
import type { NodeTag, NodeTagLink } from '../domain/node-tag';

function createDbProvider(dbOverride?: DbExecutor) {
  return () => dbOverride ?? getDb();
}

const nodeTagsLink = NodeTagLinkTable;

// Node Tag Repository
export interface NodeTagRepository {
  findById(id: string): Promise<NodeTag | null>;
  findAll(projectId: string): Promise<NodeTag[]>;
  findByName(projectId: string, name: string): Promise<NodeTag | null>;
  create(data: NodeTag): Promise<NodeTag>;
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

function nodeTagRecordToDomain(record: typeof NodeTagTable.$inferSelect): NodeTag {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createNodeTagRepository(dbOverride?: DbExecutor): NodeTagRepository {
  const dbProvider = createDbProvider(dbOverride);

  const findById = async (id: string): Promise<NodeTag | null> => {
    const rows = await dbProvider()
      .select()
      .from(NodeTagTable)
      .where(eq(NodeTagTable.id, id))
      .limit(1);
    return rows[0] ? nodeTagRecordToDomain(rows[0]) : null;
  };

  const findAll = async (projectId: string): Promise<NodeTag[]> => {
    const rows = await dbProvider()
      .select()
      .from(NodeTagTable)
      .where(eq(NodeTagTable.projectId, projectId))
      .orderBy(asc(NodeTagTable.name));
    return rows.map(nodeTagRecordToDomain);
  };

  const findByName = async (projectId: string, name: string): Promise<NodeTag | null> => {
    const rows = await dbProvider()
      .select()
      .from(NodeTagTable)
      .where(and(eq(NodeTagTable.projectId, projectId), eq(NodeTagTable.name, name)))
      .limit(1);
    return rows[0] ? nodeTagRecordToDomain(rows[0]) : null;
  };

  const create = async (data: NodeTag): Promise<NodeTag> => {
    const newTag: typeof NodeTagTable.$inferInsert = {
      id: data.id,
      projectId: data.projectId,
      name: data.name,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };

    await dbProvider().insert(NodeTagTable).values(newTag);
    return nodeTagRecordToDomain(newTag as typeof NodeTagTable.$inferSelect);
  };

  const deleteTag = async (id: string): Promise<boolean> => {
    const result = await dbProvider().delete(NodeTagTable).where(eq(NodeTagTable.id, id));
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

export function createNodeTagLinkRepository(dbOverride?: DbExecutor): NodeTagLinkRepository {
  const dbProvider = createDbProvider(dbOverride);

  const findTagsByNodeId = async (nodeId: string): Promise<NodeTag[]> => {
    const rows = await dbProvider()
      .select({
        id: NodeTagTable.id,
        projectId: NodeTagTable.projectId,
        name: NodeTagTable.name,
        createdAt: NodeTagTable.createdAt,
        updatedAt: NodeTagTable.updatedAt,
      })
      .from(NodeTagTable)
      .innerJoin(nodeTagsLink, eq(NodeTagTable.id, nodeTagsLink.tagId))
      .where(eq(nodeTagsLink.nodeId, nodeId))
      .orderBy(asc(NodeTagTable.name));

    return rows.map(nodeTagRecordToDomain);
  };

  const findNodeIdsByTagId = async (tagId: string): Promise<string[]> => {
    const rows = await dbProvider()
      .select({ nodeId: nodeTagsLink.nodeId })
      .from(nodeTagsLink)
      .where(eq(nodeTagsLink.tagId, tagId));
    return rows.map((r) => r.nodeId);
  };

  const addTagToNode = async (nodeId: string, tagId: string): Promise<NodeTagLink> => {
    await dbProvider().insert(nodeTagsLink).values({ nodeId, tagId }).onConflictDoNothing();

    return { nodeId, tagId };
  };

  const removeTagFromNode = async (nodeId: string, tagId: string): Promise<boolean> => {
    const result = await dbProvider()
      .delete(nodeTagsLink)
      .where(and(eq(nodeTagsLink.nodeId, nodeId), eq(nodeTagsLink.tagId, tagId)));
    return (result as any).rowsAffected > 0;
  };

  const removeAllTagsFromNode = async (nodeId: string): Promise<boolean> => {
    const result = await dbProvider().delete(nodeTagsLink).where(eq(nodeTagsLink.nodeId, nodeId));
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
