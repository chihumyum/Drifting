import { useCallback, useRef, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import type { Project } from '../domain/project';
import { ProjectRepositorySQLite } from '../repositories/project_sqlite';
import { useBookNode } from './useBookNode';
import { useStoryline } from './useStoryline';
import { useBookElement } from './useBookElement';

export interface CreateProjectInput {
  projectName?: string | null;
  author?: string | null;
  description?: string | null;
}

export interface UpdateProjectInput {
  projectName?: string | null;
  author?: string | null;
  description?: string | null;
}

export function useProject() {
  const repoRef = useRef(new ProjectRepositorySQLite());
  const repo = repoRef.current;
  const nodeUsecases = useBookNode();
  const storylineUsecases = useStoryline();
  const elementUsecases = useBookElement();
  
  const initializeProject = useCallback(async (projectId: string) => {
    await Promise.all([
      nodeUsecases.loadNodes({ projectId }),
      storylineUsecases.loadStorylines(projectId),
      elementUsecases.loadInitial(projectId)
    ]);
  }, [nodeUsecases, storylineUsecases, elementUsecases]);

  const loadProjects = useCallback(async (): Promise<Project[]> => {
    return await repo.findAll();
  }, [repo]);

  const loadProject = useCallback(async (id: string): Promise<Project | null> => {
    return await repo.findById(id);
  }, [repo]);

  const createProject = useCallback(async (input: CreateProjectInput): Promise<Project> => {
    const now = new Date().toISOString();
    const id = uuidv7();

    return await repo.create({
      id,
      projectName: input.projectName ?? null,
      author: input.author ?? null,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }, [repo]);

  const updateProject = useCallback(async (
    id: string,
    input: UpdateProjectInput
  ): Promise<Project | null> => {
    const now = new Date().toISOString();

    return await repo.update(id, {
      ...input,
      updatedAt: now,
    });
  }, [repo]);

  const deleteProject = useCallback(async (id: string): Promise<boolean> => {
    return await repo.delete(id);
  }, [repo]);

  const addElementCategory = useCallback(async (
    projectId: string,
    categoryId: string
  ): Promise<void> => {
    await repo.addElementCategory(projectId, categoryId);
  }, [repo]);

  const removeElementCategory = useCallback(async (
    projectId: string,
    categoryId: string
  ): Promise<void> => {
    await repo.removeElementCategory(projectId, categoryId);
  }, [repo]);

  const getElementCategories = useCallback(async (projectId: string): Promise<string[]> => {
    return await repo.getElementCategories(projectId);
  }, [repo]);

  return useMemo(() => ({
    loadProjects,
    loadProject,
    createProject,
    updateProject,
    deleteProject,
    addElementCategory,
    removeElementCategory,
    getElementCategories,
    initializeProject,
  }), [
    loadProjects,
    loadProject,
    createProject,
    updateProject,
    deleteProject,
    addElementCategory,
    removeElementCategory,
    getElementCategories,
    initializeProject,
  ]);
}