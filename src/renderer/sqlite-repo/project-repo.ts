import { getDb } from '../lib/db';
import { ProjectTable } from '../schema/drizzle';
import { eq, desc } from 'drizzle-orm';
import type { Project } from '../domain/project';
import { useAuthStore } from '../store/auth';
import LogLevel  from 'loglevel';
const log = LogLevel.getLogger("ProjectRepositorySQLite");
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
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class ProjectRepositorySQLite implements ProjectRepository {
  async findById(id: string): Promise<Project | null> {
    const rows = await getDb().select().from(ProjectTable).where(eq(ProjectTable.id, id)).limit(1);
    if (rows.length === 0) {
      log.warn(`Project with id ${id} not found`);
      return null;
    }
    return rows[0] ? recordToDomain(rows[0]) : null;
  }

  async findAll(): Promise<Project[]> {
    const currentUserId = useAuthStore.getState().user?.id;
    if (!currentUserId) {
      log.warn("No authenticated user found, loading anonymous projects");
    }
    if (!currentUserId) {
      const rows = await getDb()
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.userId, "anonymous"))
        .orderBy(desc(ProjectTable.createdAt));
      return rows.map(recordToDomain);
    }
    
    const rows = await getDb()
      .select()
      .from(ProjectTable)
      .where(eq(ProjectTable.userId, currentUserId))
      .orderBy(desc(ProjectTable.createdAt));
    return rows.map(recordToDomain);
  }

  async create(input: Project): Promise<Project> {
    const newProject: typeof ProjectTable.$inferInsert = {
      id: input.id,
      userId: input.userId,
      name: input.name,
      descriptionJson: input.descriptionJson,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };

    await getDb().insert(ProjectTable).values(newProject);

    return recordToDomain(newProject as typeof ProjectTable.$inferSelect);
  }
  async update(id: string, data: ProjectUpdateData): Promise<Project | null> {
    const existing = await this.findById(id);
    if (!existing) {
      log.warn(`Cannot update project: Project with ID ${id} does not exist.`);
      return null;
    }

    const updateValues: Partial<typeof ProjectTable.$inferInsert> = {
      updatedAt: data.updatedAt,
    };

    if (data.name !== undefined) updateValues.name = data.name;
    if (data.descriptionJson !== undefined) updateValues.descriptionJson = data.descriptionJson;
    if (data.userId !== undefined) updateValues.userId = data.userId;
    const res = await getDb().update(ProjectTable)
      .set(updateValues)
      .where(eq(ProjectTable.id, id)).returning();

    return res[0] ? recordToDomain(res[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await getDb().delete(ProjectTable).where(eq(ProjectTable.id, id));
    return (result as any).rowsAffected > 0;
  }

}