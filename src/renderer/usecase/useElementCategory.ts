import { useRef, useCallback } from 'react';
import { ElementCategoryRepositorySQLite } from '../sqlite-repo/element-category-repo';
import { BookElementCategory } from '../domain/book-element';
import { v7 as uuidv7 } from 'uuid';

export interface CreateElementCategoryInput {
  projectId: string;
  name: string;
  color: string;
  descriptionJson?: string;
}

export function useElementCategory() {
  const repoRef = useRef(new ElementCategoryRepositorySQLite());
  const repo = repoRef.current;

  const createCategory = useCallback(async (input: CreateElementCategoryInput): Promise<BookElementCategory> => {
    const now = new Date().toISOString();
    const newCategory: BookElementCategory = {
      id: uuidv7(),
      projectId: input.projectId,
      name: input.name,
      descriptionJson: input.descriptionJson ?? '{}',
      color: input.color,
      createdAt: now,
      updatedAt: now,
    };
    await repo.create(newCategory);
    return newCategory;
  }, [repo]);
  
  const loadCategories = useCallback(async (projectId: string): Promise<BookElementCategory[]> => {
    return await repo.findByProjectId(projectId);
  }, [repo]);

  return {
    createCategory,
    loadCategories
  };
}
