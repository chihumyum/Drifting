import { getDb, type DbExecutor } from '../lib/db';
import { ElementCategoryTable, BookElementTable } from '../schema/drizzle';
import { eq, asc, and, isNull, isNotNull } from 'drizzle-orm';
import type { BookElementCategory } from '../domain/book-element';
import Loglevel from 'loglevel';
const log = Loglevel.getLogger('ElementCategoryRepositorySQLite');
log.setLevel(Loglevel.levels.DEBUG);

export type ElementCategoryUpdateData = Partial<Omit<BookElementCategory, 'id' | 'createdAt'>> & {
  updatedAt: string;
};

export interface ElementCategoryRepository {
  create(category: BookElementCategory): Promise<BookElementCategory>;
  update(id: string, updates: ElementCategoryUpdateData): Promise<BookElementCategory | null>;
  findAll(): Promise<BookElementCategory[]>;
  findTrashed(): Promise<Array<BookElementCategory & { deletedAt: string }>>;
  findByName(name: string): Promise<BookElementCategory | null>;
  delete(id: string): Promise<void>;
  softDelete(id: string): Promise<void>;
  restore(id: string): Promise<void>;
}

// Default name when the user creates a category with an empty input.
// Historically this was the auto-seeded "others" bucket; that special role
// went away with the trash refactor and is now just a literal placeholder.
const DEFAULT_CATEGORY_NAME = 'untitled';
const DEFAULT_CATEGORY_COLOR = '#8B7355';

function normalizeCategoryName(name?: string): string {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_CATEGORY_NAME;
}

export function createElementCategoryRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): ElementCategoryRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const create = async (category: BookElementCategory): Promise<BookElementCategory> => {
    if (category.projectId !== projectId) {
      throw new Error(
        `Cannot create category: projectId mismatch. Expected ${projectId}, got ${category.projectId}`,
      );
    }
    const newCategory: typeof ElementCategoryTable.$inferInsert = {
      ...category,
      name: normalizeCategoryName(category.name),
      descriptionJson: category.descriptionJson ?? '{}',
      elementTemplateJson: category.elementTemplateJson ?? '{}',
      elementTemplateKvJson: category.elementTemplateKvJson ?? '[]',
      color: category.color ?? DEFAULT_CATEGORY_COLOR,
    };
    log.debug('Creating category:', newCategory);
    const inserted = await dbProvider()
      .insert(ElementCategoryTable)
      .values(newCategory)
      .returning();
    if (inserted.length > 0) {
      const candidate = inserted[0] as BookElementCategory;
      if (candidate.id && candidate.projectId && candidate.name?.trim()) {
        return candidate;
      }
      log.warn('Insert returning payload incomplete, fallback to re-query by id:', inserted[0]);
    }

    const reloaded = (
      await dbProvider()
        .select()
        .from(ElementCategoryTable)
        .where(eq(ElementCategoryTable.id, newCategory.id))
        .limit(1)
    )[0];

    if (!reloaded) {
      throw new Error(`Failed to create category ${newCategory.id}`);
    }
    return reloaded as BookElementCategory;
  };

  const update = async (
    id: string,
    updates: ElementCategoryUpdateData,
  ): Promise<BookElementCategory | null> => {
    const existing = await dbProvider()
      .select()
      .from(ElementCategoryTable)
      .where(eq(ElementCategoryTable.id, id))
      .limit(1);
    if (!existing[0]) return null;
    if (existing[0].projectId !== projectId) {
      throw new Error(
        `Cannot update category: projectId mismatch. Expected ${projectId}, got ${existing[0].projectId}`,
      );
    }

    if (updates.name) updates.name = normalizeCategoryName(updates.name);

    const updateValues: Partial<typeof ElementCategoryTable.$inferInsert> = {
      updatedAt: updates.updatedAt,
    };
    if (updates.name !== undefined) updateValues.name = updates.name;
    if (updates.color !== undefined) updateValues.color = updates.color;
    if (updates.descriptionJson !== undefined)
      updateValues.descriptionJson = updates.descriptionJson;
    if (updates.elementTemplateJson !== undefined)
      updateValues.elementTemplateJson = updates.elementTemplateJson;
    if (updates.elementTemplateKvJson !== undefined)
      updateValues.elementTemplateKvJson = updates.elementTemplateKvJson;
    if (updates.layoutMode !== undefined) updateValues.layoutMode = updates.layoutMode;
    if (updates.gridX !== undefined) updateValues.gridX = updates.gridX;
    if (updates.gridY !== undefined) updateValues.gridY = updates.gridY;

    await dbProvider()
      .update(ElementCategoryTable)
      .set(updateValues)
      .where(eq(ElementCategoryTable.id, id));

    return (
      await dbProvider()
        .select()
        .from(ElementCategoryTable)
        .where(eq(ElementCategoryTable.id, id))
        .limit(1)
    )[0] as BookElementCategory;
  };

  const findAll = async (): Promise<BookElementCategory[]> => {
    const rows = await dbProvider()
      .select()
      .from(ElementCategoryTable)
      .where(
        and(eq(ElementCategoryTable.projectId, projectId), isNull(ElementCategoryTable.deletedAt)),
      )
      .orderBy(asc(ElementCategoryTable.name));

    return rows as BookElementCategory[];
  };

  const findTrashed = async (): Promise<Array<BookElementCategory & { deletedAt: string }>> => {
    const rows = await dbProvider()
      .select()
      .from(ElementCategoryTable)
      .where(
        and(eq(ElementCategoryTable.projectId, projectId), isNotNull(ElementCategoryTable.deletedAt)),
      );
    return rows.map((r) => ({ ...(r as BookElementCategory), deletedAt: r.deletedAt as string }));
  };

  const findByName = async (name: string): Promise<BookElementCategory | null> => {
    const n = normalizeCategoryName(name);
    const rows = await dbProvider()
      .select()
      .from(ElementCategoryTable)
      .where(and(eq(ElementCategoryTable.projectId, projectId), eq(ElementCategoryTable.name, n)))
      .limit(1);

    return (rows[0] as BookElementCategory) ?? null;
  };

  const deleteCategory = async (id: string): Promise<void> => {
    // FK ON DELETE SET NULL is declared in the schema, but SQLite enforces
    // foreign keys only when PRAGMA foreign_keys=ON is set at connection
    // time — which this app does NOT do. So we manually null out child
    // categoryIds first, then drop the category row. Without this, deleted
    // categories leave elements with dangling categoryIds and the UI
    // logs "Category <id> not found" warnings.
    const now = new Date().toISOString();
    await dbProvider()
      .update(BookElementTable)
      .set({ categoryId: null, updatedAt: now })
      .where(eq(BookElementTable.categoryId, id));
    await dbProvider().delete(ElementCategoryTable).where(eq(ElementCategoryTable.id, id));
  };

  const softDeleteCategory = async (id: string): Promise<void> => {
    // FK ON DELETE SET NULL on book_element.category_id only fires on real
    // DELETE, not on soft-delete (we only flip deletedAt). Manually null the
    // child elements' categoryId so they fall into the "未分类" bucket; the
    // (filtered) categories list no longer shows the deleted row, so a
    // dangling FK there shows up as "Category <id> not found" in the UI.
    const now = new Date().toISOString();
    await dbProvider()
      .update(BookElementTable)
      .set({ categoryId: null, updatedAt: now })
      .where(eq(BookElementTable.categoryId, id));
    await dbProvider()
      .update(ElementCategoryTable)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(ElementCategoryTable.id, id));
  };

  const restoreCategory = async (id: string): Promise<void> => {
    const now = new Date().toISOString();
    await dbProvider()
      .update(ElementCategoryTable)
      .set({ deletedAt: null, updatedAt: now })
      .where(eq(ElementCategoryTable.id, id));
  };

  return {
    create,
    update,
    findAll,
    findTrashed,
    findByName,
    delete: deleteCategory,
    softDelete: softDeleteCategory,
    restore: restoreCategory,
  };
}
