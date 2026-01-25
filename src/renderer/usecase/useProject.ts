import { useCallback, useRef, useMemo } from 'react';

import type { Project } from '../domain/project';
import { ProjectRepositorySQLite } from '../sqlite-repo/project-repo';
import { useBookNode } from './useBookNode';
import { useStoryline } from './useStoryline';
import { useBookElement } from './useBookElement';
import { useElementCategory } from './useElementCategory';
import { useAuthStore } from '../store/auth';
import { v7 as uuidv7 } from 'uuid';
import LogLevel from 'loglevel';

const log = LogLevel.getLogger("UseProject");
log.setLevel(LogLevel.levels.WARN);

export interface CreateProjectInput {
  projectName?: string | null;
}

export type UpdateProjectInput = Omit<Project, 'id' | 'userId' | 'createdAt' | 'updatedAt'>;

export function useProject() {
  const repoRef = useRef(new ProjectRepositorySQLite());
  const repo = repoRef.current;
  const nodeUsecases = useBookNode();
  const storylineUsecases = useStoryline();
  const elementUsecases = useBookElement();
  const elementCategoryUsecases = useElementCategory();
  const { user } = useAuthStore();
  if (!user) {
    log.warn("No authenticated user found");
  }

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
    if (user == null) {
      // TODO: get anonymous user ID from auth store
      throw new Error("Cannot create project: No authenticated user");
    }
    const project = await repo.create({
      id: uuidv7(),
      userId: user.id,
      name: input.projectName ?? 'New Project',
      descriptionJson: '', // TODO: fix to pmJson, or Ydoc
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Enforce invariant: Project must have at least one default storyline
    await storylineUsecases.createStoryline({
      projectId: project.id,
      name: 'Default Storyline',
      color: '#3b82f6',
      summary: '',
      pmJson: '{}'
    });

    // Enforce invariant: Project must have at least one 'others' element category
    await elementCategoryUsecases.createCategory({
        projectId: project.id,
        name: 'others',
        descriptionJson: '{}',
        color: '#6b7280'
    });

    return project;
  }, [repo, user, storylineUsecases, elementCategoryUsecases]);

  const updateProject = useCallback(async (id: string, input: UpdateProjectInput): Promise<Project | null> => {
    if (user == null) {
      log.warn("Cannot update project: No authenticated user"); // TODO: handle anonymous user update if needed
      return Promise.resolve(null);
    }
    return await repo.update(id, {
      userId: user.id,
      name: input.name,
      descriptionJson: input.descriptionJson,
      updatedAt: new Date().toISOString(),
    });
  }, [repo, user]);

  const deleteProject = useCallback(async (id: string): Promise<boolean> => {
    return await repo.delete(id);
  }, [repo, user]);

  return useMemo(() => ({
    loadProjects,
    loadProject,
    createProject,
    updateProject,
    deleteProject,
    initializeProject,
  }), [
    loadProjects,
    loadProject,
    createProject,
    updateProject,
    deleteProject,
    initializeProject,
  ]);
}