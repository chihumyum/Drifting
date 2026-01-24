import { getDb } from '../lib/db';
import { projects, projectElementCategories, elementCategories } from '../schema/drizzle';
import { eq, desc, and } from 'drizzle-orm';
import type { Project } from '../domain/project';
import { v7 as uuidv7 } from 'uuid';
import { useAuthStore } from '../store/auth';

// Strict creation input: User provides name/author/desc. System handles ID/dates.
export type CreateProjectInput = {
  name: string;
  author: string;
  description?: string;
  userId?: string; // 添加 userId 参数
};

export interface ProjectUpdateData {
  projectName?: string | null;
  author?: string | null;
  description?: string | null;
  updatedAt?: string;
}

export interface ProjectRepository {
  findById(id: string): Promise<Project | null>;
  findAll(): Promise<Project[]>;
  create(input: CreateProjectInput): Promise<Project>;
  update(id: string, data: ProjectUpdateData): Promise<Project | null>;
  delete(id: string): Promise<boolean>;

  // Element category management for projects
  addElementCategory(projectId: string, categoryId: string): Promise<void>;
  removeElementCategory(projectId: string, categoryId: string): Promise<void>;
  getElementCategories(projectId: string): Promise<string[]>;
}


// Helper to map DB record to Domain entity
// Drizzle returns the inferred type from schema, which matches our domain mostly
// but we might need explicit mapping if there are null vs undefined differences or date objects vs strings
function recordToDomain(record: typeof projects.$inferSelect): Project {
  return {
    id: record.id,
    userId: record.userId,
    name: record.name,
    author: record.author,
    descriptionJson: record.descriptionJson ?? '{}',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class ProjectRepositorySQLite implements ProjectRepository {
  async findById(id: string): Promise<Project | null> {
    const rows = await getDb().select().from(projects).where(eq(projects.id, id)).limit(1);
    return rows[0] ? recordToDomain(rows[0]) : null;
  }

  async findAll(): Promise<Project[]> {
    // 只返回当前登录用户的项目
    const currentUserId = useAuthStore.getState().user?.id;
    
    if (!currentUserId) {
      // 未登录用户，返回匿名项目
      const rows = await getDb()
        .select()
        .from(projects)
        .where(eq(projects.userId, "anonymous"))
        .orderBy(desc(projects.createdAt));
      return rows.map(recordToDomain);
    }
    
    // 已登录用户，返回该用户的项目
    const rows = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.userId, currentUserId))
      .orderBy(desc(projects.createdAt));
    return rows.map(recordToDomain);
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const now = new Date().toISOString();
    const id = uuidv7();
    let userId: string;
    // 获取当前登录用户的 ID，如果没有则使用 "anonymous"
    if (!input.userId) {
      if (!useAuthStore.getState().user?.id) {
        throw new Error('Cannot create project: no user logged in');
      } else {
        userId = useAuthStore.getState().user!.id;
      }
    } else {
      userId = input.userId;
    }
    const newProject: typeof projects.$inferInsert = {
      id,
      userId,
      name: input.name,
      author: input.author,
      descriptionJson: input.description ?? '{}',
      createdAt: now,
      updatedAt: now,
    };

    await getDb().insert(projects).values(newProject);

    return recordToDomain(newProject as typeof projects.$inferSelect);
  }

  async update(id: string, data: ProjectUpdateData): Promise<Project | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();

    // Prepare update object
    const updateValues: Partial<typeof projects.$inferInsert> = {
      updatedAt: data.updatedAt ?? now,
    };

    if (data.projectName !== undefined && data.projectName !== null) updateValues.name = data.projectName;
    if (data.author !== undefined && data.author !== null) updateValues.author = data.author;
    if (data.description !== undefined && data.description !== null) updateValues.descriptionJson = data.description;

    await getDb().update(projects)
      .set(updateValues)
      .where(eq(projects.id, id));

    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await getDb().delete(projects).where(eq(projects.id, id));
    // Drizzle proxy run returns { rows: [], rowsAffected: ... }
    return (result as any).rowsAffected > 0;
  }

  async addElementCategory(projectId: string, categoryId: string): Promise<void> {
    const now = new Date().toISOString();
    await getDb().insert(projectElementCategories)
      .values({
        projectId,
        categoryId,
        createdAt: now,
      })
      .onConflictDoNothing();
  }

  async removeElementCategory(projectId: string, categoryId: string): Promise<void> {
    await getDb().delete(projectElementCategories)
      .where(
        and(
          eq(projectElementCategories.projectId, projectId),
          eq(projectElementCategories.categoryId, categoryId)
        )
      );
  }

  async getElementCategories(projectId: string): Promise<string[]> {
    const rows = await getDb().select({ categoryId: projectElementCategories.categoryId })
      .from(projectElementCategories)
      .where(eq(projectElementCategories.projectId, projectId));

    return rows.map(r => r.categoryId);
  }
}
