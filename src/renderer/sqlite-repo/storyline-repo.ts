import { getDb, type DbExecutor } from '../lib/db';
import { StorylineTable } from '../schema/drizzle';
import { eq, asc } from 'drizzle-orm';
import type { Storyline } from '../domain/storyline';
import LogLevel from 'loglevel';
const log = LogLevel.getLogger('StorylineRepository');
log.setLevel(LogLevel.levels.WARN);

export type UpdateStorylineInput = Partial<Omit<Storyline, 'id' | 'createdAt'>> & {
  updatedAt: string;
};
export interface StorylineRepository {
  // Storyline CRUD
  createStoryline(input: Storyline): Promise<Storyline>;
  getStorylineById(id: string): Promise<Storyline | null>;
  getStorylinesByProject(): Promise<Storyline[]>;
  updateStoryline(id: string, input: UpdateStorylineInput): Promise<Storyline>;
  deleteStoryline(id: string): Promise<void>;
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

export function createStorylineRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): StorylineRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const createStoryline = async (input: Storyline): Promise<Storyline> => {
    log.debug('Creating storyline:', input);
    if (input.projectId !== projectId) {
      throw new Error(
        `Cannot create storyline: projectId mismatch. Expected ${projectId}, got ${input.projectId}`,
      );
    }

    const newStoryline: typeof StorylineTable.$inferInsert = {
      id: input.id,
      projectId: input.projectId,
      name: input.name.trim(),
      color: input.color,
      summary: input.summary ?? '',
      orderKey: input.orderKey,
      descriptionJson: input.descriptionJson ?? '{}',
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
    log.debug('Inserting storyline into database:', newStoryline);

    const inserted = await dbProvider().insert(StorylineTable).values(newStoryline).returning();
    if (inserted.length > 0) {
      const candidate = toStoryline(inserted[0]);
      if (candidate.id && candidate.projectId && candidate.name?.trim()) {
        return candidate;
      }
      log.warn('Insert returning payload incomplete, fallback to re-query by id:', inserted[0]);
    } else {
      log.warn('Failed to insert storyline, no rows returned');
    }
    log.debug('Inserted storyline, now re-querying to confirm:', newStoryline.id);
    const reloaded = await getStorylineById(newStoryline.id);
    log.debug('Reloaded storyline after insert attempt:', reloaded);
    if (!reloaded) {
      throw new Error(`Failed to create storyline ${newStoryline.id}`);
    }
    return reloaded;
  };

  const getStorylineById = async (id: string): Promise<Storyline | null> => {
    const rows = await dbProvider()
      .select()
      .from(StorylineTable)
      .where(eq(StorylineTable.id, id))
      .limit(1);
    if (rows.length === 0) {
      log.warn(`Storyline with id ${id} not found`);
      return null;
    }
    log.debug(`Fetched storyline by id: ${id}`, rows[0]);
    return toStoryline(rows[0]);
  };

  const getStorylinesByProject = async (): Promise<Storyline[]> => {
    const rows = await dbProvider()
      .select()
      .from(StorylineTable)
      .where(eq(StorylineTable.projectId, projectId))
      .orderBy(asc(StorylineTable.orderKey));
    return rows.map(toStoryline);
  };

  const updateStoryline = async (id: string, input: UpdateStorylineInput): Promise<Storyline> => {
    const existing = await getStorylineById(id);
    if (!existing) {
      throw new Error(`Storyline ${id} not found`);
    }
    if (input.projectId !== existing.projectId) {
      throw new Error('Cannot change projectId of a storyline');
    }

    const updateValues: Partial<typeof StorylineTable.$inferInsert> = {
      updatedAt: input.updatedAt,
    };

    if (input.name !== undefined) updateValues.name = input.name;
    if (input.color !== undefined) updateValues.color = input.color;
    if (input.summary !== undefined) updateValues.summary = input.summary;
    if (input.orderKey !== undefined) updateValues.orderKey = input.orderKey;
    if (input.descriptionJson !== undefined) updateValues.descriptionJson = input.descriptionJson;

    const res = await dbProvider()
      .update(StorylineTable)
      .set(updateValues)
      .where(eq(StorylineTable.id, id))
      .returning();

    if (!res || res.length === 0) {
      throw new Error(`Failed to update storyline ${id}`);
    }
    return toStoryline(res[0]);
  };

  const deleteStoryline = async (id: string): Promise<void> => {
    await dbProvider().delete(StorylineTable).where(eq(StorylineTable.id, id));
  };

  return {
    createStoryline,
    getStorylineById,
    getStorylinesByProject,
    updateStoryline,
    deleteStoryline,
  };
}
