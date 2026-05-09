import { getDb } from '../lib/db';
import { StoryStageTable } from '../schema/drizzle';
import { eq, asc } from 'drizzle-orm';
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

// ==================== Story Stage Repository ====================

export function createStoryStageRepository(): StoryStageRepository {
  const findById = async (id: string): Promise<StoryStage | null> => {
    const rows = await getDb()
      .select()
      .from(StoryStageTable)
      .where(eq(StoryStageTable.id, id))
      .limit(1);
    return rows[0] ? storyStageRecordToDomain(rows[0]) : null;
  };

  const findAll = async (projectId: string): Promise<StoryStage[]> => {
    const rows = await getDb()
      .select()
      .from(StoryStageTable)
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
      updateValues.descriptionJson =
        typeof data.descriptionJson === 'string'
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
