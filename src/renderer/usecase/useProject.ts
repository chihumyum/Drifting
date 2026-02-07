import { useCallback, useMemo } from 'react';

import type { Project } from '../domain/project';
import type { Storyline } from '../domain/storyline';
import type { BookElementCategory } from '../domain/book-element';
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
    const defaultStorylineId = uuidv7();
    const createdStoryline = await storylineRepo.createStoryline({
      id: defaultStorylineId,
      projectId: project.id,
      name: 'New Storyline',
      color: randomColor(),
      summary: '',
      orderKey: 1,
      descriptionJson: '{}',
      createdAt: now,
      updatedAt: now,
    });
    log.debug("Created default storyline:", createdStoryline);
    let defaultStoryline: Storyline | null = createdStoryline;
    if (!defaultStoryline?.id || !defaultStoryline.name?.trim()) {
      defaultStoryline = await storylineRepo.getStorylineById(defaultStorylineId);
    }
    if (!defaultStoryline) {
      throw new Error('Failed to create default storyline');
    }
    if (!defaultStoryline.name?.trim()) {
      await storylineRepo.updateStoryline(defaultStoryline.id || defaultStorylineId, {
        name: 'New Storyline',
        updatedAt: new Date().toISOString(),
      });
      defaultStoryline = await storylineRepo.getStorylineById(defaultStorylineId);
      if (!defaultStoryline) {
        throw new Error('Failed to recover default storyline after name update');
      }
    }

    // Enforce invariant: Project must have at least one 'others' element category
    const categoryRepo = createElementCategoryRepository(project.id);
    const defaultCategoryId = uuidv7();
    const createdCategory = await categoryRepo.create({
      id: defaultCategoryId,
      projectId: project.id,
      name: 'others',
      descriptionJson: '{}',
      color: randomColor(),
      createdAt: now,
      updatedAt: now,
    });
    let defaultCategory: BookElementCategory | null = createdCategory;
    if (!defaultCategory?.id || !defaultCategory.name?.trim()) {
      defaultCategory = await categoryRepo.findByName('others');
    }
    if (!defaultCategory) {
      throw new Error('Failed to create default element category');
    }
    if (!defaultCategory.name?.trim()) {
      await categoryRepo.update(defaultCategory.id || defaultCategoryId, {
        name: 'others',
        updatedAt: new Date().toISOString(),
      });
      defaultCategory = await categoryRepo.findByName('others');
      if (!defaultCategory) {
        throw new Error('Failed to recover default category after name update');
      }
    }

    const [storylines, categories] = await Promise.all([
      storylineRepo.getStorylinesByProject(),
      categoryRepo.findAll(),
    ]);
    const safeStorylines = storylines.filter((s) => Boolean(s?.id) && Boolean(s?.name?.trim()));
    const safeCategories = categories.filter((c) => Boolean(c?.id) && Boolean(c?.name?.trim()));

    const dataStore = useDataStore.getState();
    dataStore.setStorylines(safeStorylines.length > 0 ? safeStorylines : [defaultStoryline]);
    dataStore.setBookElementCategories(safeCategories.length > 0 ? safeCategories : [defaultCategory]);

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
