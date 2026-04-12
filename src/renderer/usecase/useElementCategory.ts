import { useMemo, useCallback } from 'react';
import { createElementCategoryRepository } from '../sqlite-repo/element-category-repo';
import type { BookElementCategory } from '../domain/book-element';
import { v7 as uuidv7 } from 'uuid';
import { randomColor } from '../utils';
import { useDataStore } from '../store/data-store';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import { syncCategoryCreate, syncCategoryUpdate, syncCategoryDelete } from './sync-helpers';
import loglevel from "loglevel";

const log = loglevel.getLogger("useElementCategory");
log.setLevel(loglevel.levels.WARN);

export type CreateElementCategoryInput = {
  name?: string;
  descriptionJson?: string;
};

export interface UpdateElementCategoryInput {
  name?: string;
  descriptionJson?: string;
  color?: string;
}

export interface UseElementCategoryContext {
  projectId: string;
  userId: string;
}

export function useElementCategory({ projectId, userId }: UseElementCategoryContext) {
  if (!projectId) {
    throw new Error('useElementCategory requires a projectId');
  }
  if (!userId) {
    throw new Error('useElementCategory requires a userId');
  }
  const activeProjectId = projectId;
  const repo = useMemo(() => createElementCategoryRepository(activeProjectId), [activeProjectId]);
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const getCategoriesState = useCallback(() => useDataStore.getState().bookElementCategories, []);
  const setCategoriesState = useCallback((categories: BookElementCategory[]) => {
    useDataStore.getState().setBookElementCategories(categories);
  }, []);
  const addCategoryState = useCallback((category: BookElementCategory) => {
    useDataStore.getState().addBookElementCategory(category);
  }, []);
  const updateCategoryState = useCallback((id: string, updates: Partial<BookElementCategory>) => {
    useDataStore.getState().updateBookElementCategory(id, updates);
  }, []);
  const removeCategoryState = useCallback((id: string) => {
    useDataStore.getState().removeBookElementCategory(id);
  }, []);

  const createCategory = useCallback(async (input: CreateElementCategoryInput = {}): Promise<BookElementCategory> => {
    const resolved = input;
    await ensureDb();

    const now = new Date().toISOString();
    const newCategory: BookElementCategory = {
      id: uuidv7(),
      projectId: activeProjectId,
      name: resolved.name?.trim() || 'New Category',
      descriptionJson: resolved.descriptionJson ?? '{}',
      color: randomColor(),
      createdAt: now,
      updatedAt: now,
    };

    const prevCategories = getCategoriesState().slice();
    return withOptimisticUpdate({
      apply: () => addCategoryState(newCategory),
      rollback: () => setCategoriesState(prevCategories),
      effect: () => repo.create(newCategory),
      onSuccess: (created) => {
        const current = getCategoriesState();
        setCategoriesState(current.map(cat => (cat.id === created.id ? created : cat)));
      },
      sync: (created) => syncCategoryCreate(created.id, activeProjectId, {
        id: created.id, name: created.name, descriptionJson: created.descriptionJson, color: created.color,
      }),
    });
  }, [activeProjectId, addCategoryState, ensureDb, getCategoriesState, repo, setCategoriesState]);

  const loadCategories = useCallback(async (projectIdOverride?: string): Promise<BookElementCategory[]> => {
    if (projectIdOverride && projectIdOverride !== activeProjectId) {
      throw new Error('Input projectId does not match active projectId');
    }
    await ensureDb();
    const categories = await repo.findAll();
    setCategoriesState(categories);
    return categories;
  }, [repo, activeProjectId, setCategoriesState, ensureDb]);

  const updateCategory = useCallback(async (categoryId: string, updates: UpdateElementCategoryInput): Promise<BookElementCategory> => {
    await ensureDb();
    const prevCategories = getCategoriesState().slice();
    let existing = prevCategories.find(cat => cat.id === categoryId);
    if (!existing) {
      const freshCategories = await repo.findAll();
      setCategoriesState(freshCategories);
      existing = freshCategories.find(cat => cat.id === categoryId);
    }
    if (!existing) {
      throw new Error(`Category ${categoryId} not found`);
    }

    const now = new Date().toISOString();
    const updated: BookElementCategory = {
      ...existing,
      name: updates.name ?? existing.name,
      descriptionJson: updates.descriptionJson ?? existing.descriptionJson,
      color: updates.color ?? existing.color,
      updatedAt: now,
    };

    return withOptimisticUpdate({
      apply: () => updateCategoryState(categoryId, updated),
      rollback: () => setCategoriesState(prevCategories),
      effect: async () => {
        const persisted = await repo.update(categoryId, {
          name: updated.name,
          descriptionJson: updated.descriptionJson,
          color: updated.color,
          updatedAt: updated.updatedAt,
        });
        if (!persisted) {
          throw new Error(`Category ${categoryId} not found`);
        }
        return persisted;
      },
      onSuccess: (persisted) => {
        updateCategoryState(categoryId, persisted);
      },
      sync: (persisted) => syncCategoryUpdate(categoryId, activeProjectId, {
        name: persisted.name, descriptionJson: persisted.descriptionJson, color: persisted.color,
      }),
    });
  }, [ensureDb, getCategoriesState, repo, setCategoriesState, updateCategoryState, activeProjectId]);

  const deleteCategory = useCallback(async (categoryId: string): Promise<void> => {
    await ensureDb();
    const prevCategories = getCategoriesState().slice();

    return withOptimisticUpdate({
      apply: () => removeCategoryState(categoryId),
      rollback: () => setCategoriesState(prevCategories),
      effect: () => repo.delete(categoryId),
      sync: () => syncCategoryDelete(categoryId, activeProjectId),
    });
  }, [ensureDb, getCategoriesState, removeCategoryState, repo, setCategoriesState, activeProjectId]);

  const getCategoryColor = useCallback((categoryId: string): string => {
    if (!categoryId) {
      log.error('getCategoryColor called with empty categoryId');
    }

    const existing = getCategoriesState().find(cat => cat.id === categoryId);
    const existingColor = existing?.color?.trim();
    if (existingColor) {
      return existingColor;
    } else {
      log.error(`Category ${categoryId} not found when getting color. Falling back to generated color.`);
      return randomColor();
    }
  }, [getCategoriesState]);

  return useMemo(() => ({
    createCategory,
    loadCategories,
    updateCategory,
    deleteCategory,
    getCategoryColor,
  }), [createCategory, loadCategories, updateCategory, deleteCategory, getCategoryColor]);
}
