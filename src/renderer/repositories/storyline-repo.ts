import { getDb } from '../lib/db';
import { storylines, nodeStorylines } from '../schema/drizzle';
import { eq, desc, asc, and } from 'drizzle-orm';
import type { Storyline, CreateStorylineInput, UpdateStorylineInput } from '../domain/storyline';
import { v7 as uuidv7 } from 'uuid';



export interface StorylineRepository {
  // Storyline CRUD
  createStoryline(input: CreateStorylineInput): Promise<Storyline>;
  getStorylineById(id: string): Promise<Storyline | null>;
  getStorylinesByProject(projectId: string): Promise<Storyline[]>;
  updateStoryline(input: UpdateStorylineInput): Promise<Storyline>;
  deleteStoryline(id: string): Promise<void>;
  
  // Node-Storyline relationships
  addNodeToStoryline(nodeId: string, storylineId: string): Promise<void>;
  removeNodeFromStoryline(nodeId: string, storylineId: string): Promise<void>;
  getStorylinesByNode(nodeId: string): Promise<Storyline[]>;
  getNodeIdsByStoryline(storylineId: string): Promise<string[]>;
  setNodeStorylines(nodeId: string, storylineIds: string[]): Promise<void>;
}



function toStoryline(record: typeof storylines.$inferSelect): Storyline {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    color: record.color,
    summary: record.summary ?? '',
    descriptionJson: record.descriptionJson ? JSON.parse(record.descriptionJson) : {},
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

export class StorylineSQLiteRepository implements StorylineRepository {
  async createStoryline(input: CreateStorylineInput): Promise<Storyline> {
    const id = uuidv7();
    const now = new Date().toISOString();

    const newStoryline: typeof storylines.$inferInsert = {
      id,
      projectId: input.projectId,
      name: input.name,
      color: input.color,
      summary: input.summary ?? '',
      descriptionJson: input.pmJson ?? '{}',
      createdAt: now,
      updatedAt: now,
    };

    await getDb().insert(storylines).values(newStoryline);

    return toStoryline(newStoryline as typeof storylines.$inferSelect);
  }

  async getStorylineById(id: string): Promise<Storyline | null> {
    const rows = await getDb().select().from(storylines).where(eq(storylines.id, id)).limit(1);
    return rows[0] ? toStoryline(rows[0]) : null;
  }

  async getStorylinesByProject(projectId: string): Promise<Storyline[]> {
    const rows = await getDb().select()
      .from(storylines)
      .where(eq(storylines.projectId, projectId))
      .orderBy(asc(storylines.name));
    return rows.map(toStoryline);
  }

  async updateStoryline(input: UpdateStorylineInput): Promise<Storyline> {
    const existing = await this.getStorylineById(input.id);
    if (!existing) {
      throw new Error(`Storyline ${input.id} not found`);
    }

    const now = new Date().toISOString();
    const updateValues: Partial<typeof storylines.$inferInsert> = {
      updatedAt: now,
    };

    if (input.name !== undefined) updateValues.name = input.name;
    if (input.color !== undefined) updateValues.color = input.color;
    if (input.summary !== undefined) updateValues.summary = input.summary;
    if (input.pmJson !== undefined) updateValues.descriptionJson = input.pmJson;

    await getDb().update(storylines)
      .set(updateValues)
      .where(eq(storylines.id, input.id));

    const updated = await this.getStorylineById(input.id);
    if (!updated) throw new Error('Failed to retrieve updated storyline');
    return updated;
  }

  async deleteStoryline(id: string): Promise<void> {
    await getDb().delete(storylines).where(eq(storylines.id, id));
  }

  async addNodeToStoryline(nodeId: string, storylineId: string): Promise<void> {
    // Determine next order
    const existingLinks = await getDb().select({ order: nodeStorylines.storylineOrder })
      .from(nodeStorylines)
      .where(eq(nodeStorylines.nodeId, nodeId));

    const maxOrder = existingLinks.reduce((max, link) => Math.max(max, link.order), -1);
    const nextOrder = maxOrder + 1;

    await getDb().insert(nodeStorylines)
      .values({
        nodeId,
        storylineId,
        storylineOrder: nextOrder,
      })
      .onConflictDoNothing();
  }

  async removeNodeFromStoryline(nodeId: string, storylineId: string): Promise<void> {
    await getDb().delete(nodeStorylines)
      .where(and(
        eq(nodeStorylines.nodeId, nodeId),
        eq(nodeStorylines.storylineId, storylineId)
      ));
  }

  async getStorylinesByNode(nodeId: string): Promise<Storyline[]> {
    // Join storylines and nodeStorylines
    // Select storylines.* order by nodeStorylines.storylineOrder
    const rows = await getDb().select({
      storyline: storylines
    })
      .from(storylines)
      .innerJoin(nodeStorylines, eq(storylines.id, nodeStorylines.storylineId))
      .where(eq(nodeStorylines.nodeId, nodeId))
      .orderBy(asc(nodeStorylines.storylineOrder));

    return rows.map(r => toStoryline(r.storyline));
  }

  async getNodeIdsByStoryline(storylineId: string): Promise<string[]> {
    const rows = await getDb().select({ nodeId: nodeStorylines.nodeId })
      .from(nodeStorylines)
      .where(eq(nodeStorylines.storylineId, storylineId));

    return rows.map(r => r.nodeId);
  }

  async setNodeStorylines(nodeId: string, storylineIds: string[]): Promise<void> {
    await getDb().transaction(async (tx) => {
      // Clear existing
      await tx.delete(nodeStorylines).where(eq(nodeStorylines.nodeId, nodeId));

      // Insert new with order
      if (storylineIds.length > 0) {
        await tx.insert(nodeStorylines).values(
          storylineIds.map((sid, index) => ({
            nodeId,
            storylineId: sid,
            storylineOrder: index,
          }))
        );
      }
    });
  }
}

// Placeholder sync functions
export interface RemoteStorylinePayload { }
export async function markStorylineSyncStatus(id: string, status: any, options?: any) { }
export async function cleanupSyncedDeletedStorylines() { }
export async function applyRemoteStoryline(payload: any) { return 'skipped'; }
