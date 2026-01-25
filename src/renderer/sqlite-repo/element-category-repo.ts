import { getDb } from '../lib/db';
import { ElementCategoryTable } from '../schema/drizzle';
import { eq, asc, and } from 'drizzle-orm';
import type { BookElementCategory } from '../domain/book-element';

export type ElementCategoryUpdateData = Partial<Omit<BookElementCategory, 'id' | 'createdAt'>> & { updatedAt: string };

export interface ElementCategoryRepository {
  create(category: BookElementCategory): Promise<BookElementCategory>;
  update(id: string, updates: ElementCategoryUpdateData): Promise<BookElementCategory | null>;
  findAll(): Promise<BookElementCategory[]>;
  findByName(name: string): Promise<BookElementCategory | null>;
  delete(id: string): Promise<void>;
}

const DEFAULT_CATEGORY_NAME = 'others';

function normalizeCategoryName(name?: string): string {
    const trimmed = name?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_CATEGORY_NAME;
}

type DbClient = ReturnType<typeof getDb>;

export function createElementCategoryRepository(projectId: string, dbOverride?: DbClient): ElementCategoryRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const create = async (category: BookElementCategory): Promise<BookElementCategory> => {
    if (category.projectId !== projectId) {
      throw new Error(`Cannot create category: projectId mismatch. Expected ${projectId}, got ${category.projectId}`);
    }
    category.name = normalizeCategoryName(category.name);
    await dbProvider().insert(ElementCategoryTable).values(category);
    return category;
  };

  const update = async (id: string, updates: ElementCategoryUpdateData): Promise<BookElementCategory | null> => {
    const existing = await dbProvider().select().from(ElementCategoryTable).where(eq(ElementCategoryTable.id, id)).limit(1);
    if (!existing[0]) return null;
    if (existing[0].projectId !== projectId) {
      throw new Error(`Cannot update category: projectId mismatch. Expected ${projectId}, got ${existing[0].projectId}`);
    }

    if (updates.name) updates.name = normalizeCategoryName(updates.name);

    const updateValues: Partial<typeof ElementCategoryTable.$inferInsert> = {
        updatedAt: updates.updatedAt,
    };
    if (updates.name !== undefined) updateValues.name = updates.name;
    if (updates.color !== undefined) updateValues.color = updates.color;
    if (updates.descriptionJson !== undefined) updateValues.descriptionJson = updates.descriptionJson;

    await dbProvider().update(ElementCategoryTable)
        .set(updateValues)
        .where(eq(ElementCategoryTable.id, id));

    return (await dbProvider().select().from(ElementCategoryTable).where(eq(ElementCategoryTable.id, id)).limit(1))[0] as BookElementCategory;
  };

  const findAll = async (): Promise<BookElementCategory[]> => {
    const rows = await dbProvider()
      .select()
      .from(ElementCategoryTable)
      .where(eq(ElementCategoryTable.projectId, projectId))
      .orderBy(asc(ElementCategoryTable.name));
    
    return rows as BookElementCategory[];
  };

  const findByName = async (name: string): Promise<BookElementCategory | null> => {
    const n = normalizeCategoryName(name);
    const rows = await dbProvider()
        .select()
        .from(ElementCategoryTable)
        .where(and(
            eq(ElementCategoryTable.projectId, projectId),
            eq(ElementCategoryTable.name, n)
        ))
        .limit(1);
    
    return (rows[0] as BookElementCategory) ?? null;
  };

  const deleteCategory = async (id: string): Promise<void> => {
    // Invariant check: need count of categories in this project
    const target = (await dbProvider().select().from(ElementCategoryTable).where(eq(ElementCategoryTable.id, id)).limit(1))[0];
    if (!target) return;
    if (target.projectId !== projectId) {
      throw new Error(`Cannot delete category: projectId mismatch. Expected ${projectId}, got ${target.projectId}`);
    }

    const allCats = await dbProvider().select({ id: ElementCategoryTable.id }).from(ElementCategoryTable)
        .where(eq(ElementCategoryTable.projectId, projectId));
    
    if (allCats.length <= 1) {
        throw new Error("Cannot delete the last category in the project.");
    }

    await dbProvider().delete(ElementCategoryTable).where(eq(ElementCategoryTable.id, id));
  };

  return {
    create,
    update,
    findAll,
    findByName,
    delete: deleteCategory,
  };
}
