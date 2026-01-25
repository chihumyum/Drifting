import { getDb } from '../lib/db';
import { BookNodeTable, NodeStorylineLinkTable, StorylineTable } from '../schema/drizzle';
import { eq, asc, and, inArray } from 'drizzle-orm';
import type { Storyline } from '../domain/storyline';

type DbClient = ReturnType<typeof getDb>;

export interface NodeStorylineLinkRepository {
  addNodeToStoryline(nodeId: string, storylineId: string): Promise<void>;
  removeNodeFromStoryline(nodeId: string, storylineId: string): Promise<void>;
  getStorylinesByNode(nodeId: string): Promise<Storyline[]>;
  getNodeIdsByStoryline(storylineId: string): Promise<string[]>;
  setNodeStorylines(nodeId: string, storylineIds: string[]): Promise<void>;
}

function toStoryline(record: typeof StorylineTable.$inferSelect): Storyline {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    color: record.color,
    summary: record.summary,
    orderKey: record.orderKey,
    descriptionJson: record.descriptionJson,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createNodeStorylineLinkRepository(projectId: string, dbOverride?: DbClient): NodeStorylineLinkRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const ensureStorylineInProject = async (storylineId: string): Promise<void> => {
    const rows = await dbProvider().select({ id: StorylineTable.id })
      .from(StorylineTable)
      .where(and(eq(StorylineTable.projectId, projectId), eq(StorylineTable.id, storylineId)))
      .limit(1);
    if (!rows[0]) {
      throw new Error(`Storyline ${storylineId} not found in project ${projectId}`);
    }
  };

  const ensureNodeInProject = async (nodeId: string): Promise<void> => {
    const rows = await dbProvider().select({ id: BookNodeTable.id })
      .from(BookNodeTable)
      .where(and(eq(BookNodeTable.projectId, projectId), eq(BookNodeTable.id, nodeId)))
      .limit(1);
    if (!rows[0]) {
      throw new Error(`Node ${nodeId} not found in project ${projectId}`);
    }
  };

  const addNodeToStoryline = async (nodeId: string, storylineId: string): Promise<void> => {
    await Promise.all([
      ensureStorylineInProject(storylineId),
      ensureNodeInProject(nodeId),
    ]);

    await dbProvider().insert(NodeStorylineLinkTable)
      .values({
        nodeId,
        storylineId,
      })
      .onConflictDoNothing();
  };

  const removeNodeFromStoryline = async (nodeId: string, storylineId: string): Promise<void> => {
    await dbProvider().delete(NodeStorylineLinkTable)
      .where(and(
        eq(NodeStorylineLinkTable.nodeId, nodeId),
        eq(NodeStorylineLinkTable.storylineId, storylineId)
      ));
  };

  const getStorylinesByNode = async (nodeId: string): Promise<Storyline[]> => {
    const rows = await dbProvider().select({
      storyline: StorylineTable
    })
      .from(StorylineTable)
      .innerJoin(NodeStorylineLinkTable, eq(StorylineTable.id, NodeStorylineLinkTable.storylineId))
      .where(and(
        eq(NodeStorylineLinkTable.nodeId, nodeId),
        eq(StorylineTable.projectId, projectId)
      ))
      .orderBy(asc(StorylineTable.orderKey));

    return rows.map(r => toStoryline(r.storyline));
  };

  const getNodeIdsByStoryline = async (storylineId: string): Promise<string[]> => {
    await ensureStorylineInProject(storylineId);

    const rows = await dbProvider().select({ nodeId: NodeStorylineLinkTable.nodeId })
      .from(NodeStorylineLinkTable)
      .where(eq(NodeStorylineLinkTable.storylineId, storylineId));

    return rows.map(r => r.nodeId);
  };

  const setNodeStorylines = async (nodeId: string, storylineIds: string[]): Promise<void> => {
    await ensureNodeInProject(nodeId);

    if (storylineIds.length > 0) {
      const rows = await dbProvider().select({ id: StorylineTable.id })
        .from(StorylineTable)
        .where(and(
          eq(StorylineTable.projectId, projectId),
          inArray(StorylineTable.id, storylineIds)
        ));
      if (rows.length !== storylineIds.length) {
        throw new Error('One or more storylines do not belong to the active project.');
      }
    }

    await dbProvider().transaction(async (tx) => {
      await tx.delete(NodeStorylineLinkTable).where(eq(NodeStorylineLinkTable.nodeId, nodeId));

      if (storylineIds.length > 0) {
        await tx.insert(NodeStorylineLinkTable).values(
          storylineIds.map((sid) => ({
            nodeId,
            storylineId: sid,
          }))
        );
      }
    });
  };

  return {
    addNodeToStoryline,
    removeNodeFromStoryline,
    getStorylinesByNode,
    getNodeIdsByStoryline,
    setNodeStorylines,
  };
}
