import { useCallback, useMemo } from 'react';

import type { Project } from '../domain/project';
import { createProjectRepository } from '../sqlite-repo/project-repo';
import { createStorylineRepository } from '../sqlite-repo/storyline-repo';
import { createElementCategoryRepository } from '../sqlite-repo/element-category-repo';
import { initDatabase } from '../lib/db';
import { v7 as uuidv7 } from 'uuid';
import { randomColor } from '../utils';
import { useDataStore } from '../store/data-store';
import LogLevel from 'loglevel';
const log = LogLevel.getLogger("UseProject");
log.setLevel(LogLevel.levels.WARN);

export interface CreateProjectInput {
  projectName?: string | null;
}

export type UpdateProjectInput = Omit<Project, 'id' | 'userId' | 'createdAt' | 'updatedAt'>;

export interface UseProjectContext {
  userId: string;
}

export function useProject({ userId }: UseProjectContext) {
  const repo = useMemo(() => createProjectRepository(userId), [userId]);
  const ensureDb = useCallback(async () => {
    if (!userId) {
      log.warn('No authenticated user found');
      throw new Error('Cannot access projects without a userId');
    }
    await initDatabase(userId);
  }, [userId]);

  const loadProjects = useCallback(async (): Promise<Project[]> => {
    await ensureDb();
    return await repo.findAll();
  }, [repo, ensureDb]);

  const loadProject = useCallback(async (id: string): Promise<Project | null> => {
    await ensureDb();
    return await repo.findById(id);
  }, [repo, ensureDb]);

  const createProject = useCallback(async (input: CreateProjectInput): Promise<Project> => {
    if (!userId) {
      throw new Error('Cannot create project: No authenticated user');
    }
    await ensureDb();

    const now = new Date().toISOString();
    const project = await repo.create({
      id: uuidv7(),
      userId,
      name: input.projectName ?? 'New Project',
      descriptionJson: '', // TODO: fix to pmJson, or Ydoc
      createdAt: now,
      updatedAt: now,
    });

    // Enforce invariant: Project must have at least one default storyline
    const storylineRepo = createStorylineRepository(project.id);
    const defaultStoryline = await storylineRepo.createStoryline({
      id: uuidv7(),
      projectId: project.id,
      name: 'New Storyline',
      color: randomColor(),
      summary: '',
      orderKey: 1,
      descriptionJson: '{}',
      createdAt: now,
      updatedAt: now,
    });

    // Enforce invariant: Project must have at least one 'others' element category
    const categoryRepo = createElementCategoryRepository(project.id);
    const defaultCategory = await categoryRepo.create({
      id: uuidv7(),
      projectId: project.id,
      name: 'others',
      descriptionJson: '{}',
      color: randomColor(),
      createdAt: now,
      updatedAt: now,
    });

    const dataStore = useDataStore.getState();
    dataStore.setStorylines([defaultStoryline]);
    dataStore.setBookElementCategories([defaultCategory]);

    return project;
  }, [repo, userId, ensureDb]);

  const updateProject = useCallback(async (id: string, input: UpdateProjectInput): Promise<Project | null> => {
    if (!userId) {
      log.warn('Cannot update project: No authenticated user');
      return Promise.resolve(null);
    }
    await ensureDb();
    return await repo.update(id, {
      userId,
      name: input.name,
      descriptionJson: input.descriptionJson,
      updatedAt: new Date().toISOString(),
    });
  }, [repo, userId, ensureDb]);

  const deleteProject = useCallback(async (id: string): Promise<boolean> => {
    await ensureDb();
    return await repo.delete(id);
  }, [repo, ensureDb]);

  return useMemo(() => ({
    loadProjects,
    loadProject,
    createProject,
    updateProject,
    deleteProject,
  }), [
    loadProjects,
    loadProject,
    createProject,
    updateProject,
    deleteProject,
  ]);
}
