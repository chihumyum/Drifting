import { useMemo, useCallback } from 'react';
import { createElementCategoryRepository } from '../sqlite-repo/element-category-repo';
import { BookElementCategory } from '../domain/book-element';
import { v7 as uuidv7 } from 'uuid';
import { useParams } from 'react-router-dom';
import { randomColor } from '../utils';

export interface CreateElementCategoryInput {
  projectId?: string;
}

export function useElementCategory() {
  // Use route projectId - this is the ONLY source of truth for projectId
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  if (!routeProjectId) {
      throw new Error("useBookElement must be used within a project route");
  }
  const activeProjectId = routeProjectId;
  const repo = useMemo(() => createElementCategoryRepository(activeProjectId), [activeProjectId]);

  const createCategory = useCallback(async (input: CreateElementCategoryInput): Promise<BookElementCategory> => {
    if (input.projectId && input.projectId !== activeProjectId) {
      throw new Error("Input projectId does not match active projectId");
    }
    const now = new Date().toISOString();
    const newCategory: BookElementCategory = {
      id: uuidv7(),
      projectId: activeProjectId,
      name: 'New Category',
      descriptionJson: '{}',
      color: randomColor(),
      createdAt: now,
      updatedAt: now,
    };
    await repo.create(newCategory);
    return newCategory;
  }, [repo, activeProjectId]);
  
  const loadCategories = useCallback(async (projectId?: string): Promise<BookElementCategory[]> => {
    if (projectId && projectId !== activeProjectId) {
      throw new Error("Input projectId does not match active projectId");
    }
    return await repo.findAll();
  }, [repo, activeProjectId]);

  return {
    createCategory,
    loadCategories
  };
}
