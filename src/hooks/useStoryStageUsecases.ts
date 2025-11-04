// React hooks for Story Stage management
import { useMemo, useRef } from 'react';
import { 
  createStoryStageRepository,
} from '../repositories/story_stage_sqlite';
import type { StoryStageUsecaseDeps } from '../usecase/story_stage';
import {
  loadStoryStages,
  getStoryStageById,
  createStoryStage,
  updateStoryStage,
  deleteStoryStage,
  reorderStoryStage,
  type CreateStoryStageInput,
  type UpdateStoryStageInput,
} from '../usecase/story_stage';
import { initDatabase } from '../lib/db';

const PROJECT_ID = 'default-project';

export function useStoryStageUsecases() {
  const depsRef = useRef<StoryStageUsecaseDeps | null>(null);

  if (!depsRef.current) {
    depsRef.current = {
      stageRepo: createStoryStageRepository(),
      now: () => new Date(),
    };
  }

  const deps = depsRef.current!;

  return useMemo(() => ({
    loadStages: async (projectId: string = PROJECT_ID) => {
      await initDatabase(projectId);
      return loadStoryStages(deps, projectId);
    },
    getStageById: async (id: string, projectId: string = PROJECT_ID) => {
      await initDatabase(projectId);
      return getStoryStageById(deps, id);
    },
    createStage: async (input: CreateStoryStageInput) => {
      await initDatabase(input.projectId ?? PROJECT_ID);
      return createStoryStage(deps, {
        ...input,
        projectId: input.projectId ?? PROJECT_ID,
      });
    },
    updateStage: async (id: string, input: UpdateStoryStageInput, projectId: string = PROJECT_ID) => {
      await initDatabase(projectId);
      return updateStoryStage(deps, id, input);
    },
    deleteStage: async (id: string, projectId: string = PROJECT_ID) => {
      await initDatabase(projectId);
      return deleteStoryStage(deps, id);
    },
    reorderStage: async (id: string, direction: 'up' | 'down', projectId: string = PROJECT_ID) => {
      await initDatabase(projectId);
      return reorderStoryStage(deps, projectId, id, direction);
    },
    _deps: deps,
  }), [deps]);
}
