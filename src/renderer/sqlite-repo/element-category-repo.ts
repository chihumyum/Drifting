import { getDb } from '../lib/db';
import { ElementCategoryTable } from '../schema/drizzle';
import { eq, asc, and } from 'drizzle-orm';
import type { BookElementCategory } from '../domain/book-element';

export type ElementCategoryUpdateData = Partial<Omit<BookElementCategory, 'id' | 'createdAt'>> & { updatedAt: string };

export interface ElementCategoryRepository {
  create(category: BookElementCategory): Promise<BookElementCategory>;
  update(id: string, updates: ElementCategoryUpdateData): Promise<BookElementCategory | null>;
  findByProjectId(projectId: string): Promise<BookElementCategory[]>;
  findByName(projectId: string, name: string): Promise<BookElementCategory | null>;
  delete(id: string): Promise<void>;
}

const DEFAULT_CATEGORY_NAME = 'others';

function normalizeCategoryName(name?: string): string {
    const trimmed = name?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_CATEGORY_NAME;
}

export class ElementCategoryRepositorySQLite implements ElementCategoryRepository {
  async create(category: BookElementCategory): Promise<BookElementCategory> {
    category.name = normalizeCategoryName(category.name);
    await getDb().insert(ElementCategoryTable).values(category);
    return category;
  }

  async update(id: string, updates: ElementCategoryUpdateData): Promise<BookElementCategory | null> {
    const existing = await getDb().select().from(ElementCategoryTable).where(eq(ElementCategoryTable.id, id)).limit(1);
    if (!existing[0]) return null;

    if (updates.name) updates.name = normalizeCategoryName(updates.name);

    const updateValues: Partial<typeof ElementCategoryTable.$inferInsert> = {
        updatedAt: updates.updatedAt,
    };
    if (updates.name !== undefined) updateValues.name = updates.name;
    if (updates.color !== undefined) updateValues.color = updates.color;
    if (updates.descriptionJson !== undefined) updateValues.descriptionJson = updates.descriptionJson;

    await getDb().update(ElementCategoryTable)
        .set(updateValues)
        .where(eq(ElementCategoryTable.id, id));

    return (await getDb().select().from(ElementCategoryTable).where(eq(ElementCategoryTable.id, id)).limit(1))[0] as BookElementCategory;
  }

  async findByProjectId(projectId: string): Promise<BookElementCategory[]> {
    const rows = await getDb()
      .select()
      .from(ElementCategoryTable)
      .where(eq(ElementCategoryTable.projectId, projectId))
      .orderBy(asc(ElementCategoryTable.name));
    
    return rows as BookElementCategory[];
  }

  async findByName(projectId: string, name: string): Promise<BookElementCategory | null> {
    const n = normalizeCategoryName(name);
    const rows = await getDb()
        .select()
        .from(ElementCategoryTable)
        .where(and(
            eq(ElementCategoryTable.projectId, projectId),
            eq(ElementCategoryTable.name, n)
        ))
        .limit(1);
    
    return (rows[0] as BookElementCategory) ?? null;
  }

  async delete(id: string): Promise<void> {
    // Invariant check: need count of categories in this project
    const target = (await getDb().select().from(ElementCategoryTable).where(eq(ElementCategoryTable.id, id)).limit(1))[0];
    if (!target) return;

    const currentProjectId = target.projectId;
    const allCats = await getDb().select({ id: ElementCategoryTable.id }).from(ElementCategoryTable)
        .where(eq(ElementCategoryTable.projectId, currentProjectId));
    
    if (allCats.length <= 1) {
        throw new Error("Cannot delete the last category in the project.");
    }

    await getDb().delete(ElementCategoryTable).where(eq(ElementCategoryTable.id, id));
  }
}
