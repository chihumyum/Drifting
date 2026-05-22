import { getDb } from '../lib/db';
import { ProjectTable } from '../schema/drizzle';
import { eq, desc } from 'drizzle-orm';
import type { Project } from '../domain/project';
import LogLevel from 'loglevel';
const log = LogLevel.getLogger('ProjectRepositorySQLite');
log.setLevel(LogLevel.levels.WARN);

export type ProjectUpdateData = Partial<Omit<Project, 'id' | 'createdAt'>> & { updatedAt: string };

export interface ProjectRepository {
  findById(id: string): Promise<Project | null>;
  findAll(): Promise<Project[]>;
  create(input: Project): Promise<Project>;
  update(id: string, data: ProjectUpdateData): Promise<Project | null>;
  delete(id: string): Promise<boolean>;

  // Element category management for projects
}

// Helper to map DB record to Domain entity
// Drizzle returns the inferred type from schema, which matches our domain mostly
// but we might need explicit mapping if there are null vs undefined differences or date objects vs strings
function recordToDomain(record: typeof ProjectTable.$inferSelect): Project {
  return {
    id: record.id,
    userId: record.userId,
    name: record.name,
    descriptionJson: record.descriptionJson ?? '{}',
    kvJson: record.kvJson ?? '[]',
    storylineTemplateKvJson: record.storylineTemplateKvJson ?? '[]',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createProjectRepository(currentUserId?: string): ProjectRepository {
  const userId = currentUserId ?? 'anonymous';

  const findById = async (id: string): Promise<Project | null> => {
    const rows = await getDb().select().from(ProjectTable).where(eq(ProjectTable.id, id)).limit(1);
    if (rows.length === 0) {
      log.warn(`Project with id ${id} not found`);
      return null;
    }
    return rows[0] ? recordToDomain(rows[0]) : null;
  };

  const findAll = async (): Promise<Project[]> => {
    if (!currentUserId) {
      log.warn('No authenticated user found, loading anonymous projects');
    }

    const rows = await getDb()
      .select()
      .from(ProjectTable)
      .where(eq(ProjectTable.userId, userId))
      .orderBy(desc(ProjectTable.createdAt));
    return rows.map(recordToDomain);
  };

  const create = async (input: Project): Promise<Project> => {
    if (input.userId !== userId) {
      throw new Error(
        `Cannot create project: userId mismatch. Expected ${userId}, got ${input.userId}`,
      );
    }

    const newProject: typeof ProjectTable.$inferInsert = {
      id: input.id,
      userId: input.userId,
      name: input.name,
      descriptionJson: input.descriptionJson,
      kvJson: input.kvJson,
      storylineTemplateKvJson: input.storylineTemplateKvJson,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };

    await getDb().insert(ProjectTable).values(newProject);

    return recordToDomain(newProject as typeof ProjectTable.$inferSelect);
  };

  const update = async (id: string, data: ProjectUpdateData): Promise<Project | null> => {
    const existing = await findById(id);
    if (!existing) {
      log.warn(`Cannot update project: Project with ID ${id} does not exist.`);
      return null;
    }
    if (data.userId !== undefined && data.userId !== userId) {
      throw new Error(
        `Cannot update project: userId mismatch. Expected ${userId}, got ${data.userId}`,
      );
    }

    const updateValues: Partial<typeof ProjectTable.$inferInsert> = {
      updatedAt: data.updatedAt,
    };

    if (data.name !== undefined) updateValues.name = data.name;
    if (data.descriptionJson !== undefined) updateValues.descriptionJson = data.descriptionJson;
    if (data.kvJson !== undefined) updateValues.kvJson = data.kvJson;
    if (data.storylineTemplateKvJson !== undefined)
      updateValues.storylineTemplateKvJson = data.storylineTemplateKvJson;
    if (data.userId !== undefined) updateValues.userId = data.userId;
    const res = await getDb()
      .update(ProjectTable)
      .set(updateValues)
      .where(eq(ProjectTable.id, id))
      .returning();

    return res[0] ? recordToDomain(res[0]) : null;
  };

  const deleteProject = async (id: string): Promise<boolean> => {
    const result = await getDb().delete(ProjectTable).where(eq(ProjectTable.id, id));
    return (result as any).rowsAffected > 0;
  };

  return {
    findById,
    findAll,
    create,
    update,
    delete: deleteProject,
  };
}
