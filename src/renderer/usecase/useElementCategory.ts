import { useMemo, useCallback } from 'react';
import { createElementCategoryRepository } from '../sqlite-repo/element-category-repo';
import type { BookElementCategory } from '../domain/book-element';
import { v7 as uuidv7 } from 'uuid';
import { randomColor } from '../utils';
import { useDataStore } from '../store/data-store';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';

export interface CreateElementCategoryInput {
  name?: string;
  descriptionJson?: string;
  color?: string;
  projectId?: string;
}

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

  const resolveCategoryId = useCallback(async (categoryIdOrName: string) => {
    const existing = getCategoriesState().find(cat => cat.id === categoryIdOrName || cat.name === categoryIdOrName);
    if (existing) return existing.id;

    await ensureDb();
    const fromRepo = await repo.findByName(categoryIdOrName);
    if (!fromRepo) {
      throw new Error(`Category ${categoryIdOrName} not found`);
    }
    return fromRepo.id;
  }, [getCategoriesState, ensureDb, repo]);

  const createCategory = useCallback(async (input: CreateElementCategoryInput | string): Promise<BookElementCategory> => {
    const resolved = typeof input === 'string' ? { name: input } : input;
    if (resolved.projectId && resolved.projectId !== activeProjectId) {
      throw new Error('Input projectId does not match active projectId');
    }
    await ensureDb();

    const now = new Date().toISOString();
    const newCategory: BookElementCategory = {
      id: uuidv7(),
      projectId: activeProjectId,
      name: resolved.name?.trim() || 'New Category',
      descriptionJson: resolved.descriptionJson ?? '{}',
      color: resolved.color ?? randomColor(),
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

  const updateCategory = useCallback(async (categoryIdOrName: string, updates: UpdateElementCategoryInput): Promise<BookElementCategory> => {
    await ensureDb();
    const targetId = await resolveCategoryId(categoryIdOrName);
    const prevCategories = getCategoriesState().slice();
    const existing = prevCategories.find(cat => cat.id === targetId);
    if (!existing) {
      throw new Error(`Category ${categoryIdOrName} not found`);
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
      apply: () => updateCategoryState(targetId, updated),
      rollback: () => setCategoriesState(prevCategories),
      effect: async () => {
        const persisted = await repo.update(targetId, {
          name: updated.name,
          descriptionJson: updated.descriptionJson,
          color: updated.color,
          updatedAt: updated.updatedAt,
        });
        if (!persisted) {
          throw new Error(`Category ${categoryIdOrName} not found`);
        }
        return persisted;
      },
      onSuccess: (persisted) => {
        updateCategoryState(targetId, persisted);
      },
    });
  }, [ensureDb, getCategoriesState, resolveCategoryId, repo, setCategoriesState, updateCategoryState]);

  const deleteCategory = useCallback(async (categoryIdOrName: string): Promise<void> => {
    await ensureDb();
    const targetId = await resolveCategoryId(categoryIdOrName);
    const prevCategories = getCategoriesState().slice();

    return withOptimisticUpdate({
      apply: () => removeCategoryState(targetId),
      rollback: () => setCategoriesState(prevCategories),
      effect: () => repo.delete(targetId),
    });
  }, [ensureDb, getCategoriesState, removeCategoryState, resolveCategoryId, repo, setCategoriesState]);

  return useMemo(() => ({
    createCategory,
    loadCategories,
    updateCategory,
    deleteCategory,
  }), [createCategory, loadCategories, updateCategory, deleteCategory]);
}
