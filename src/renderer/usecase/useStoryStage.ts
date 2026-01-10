import { useMemo, useRef, useCallback } from 'react';
import { createStoryStageRepository } from '../repositories/story_stage_sqlite';
import { StoryStage } from '../domain/storystage';
import { initDatabase } from '../lib/db';
import { useAuthStore, getProjectId } from '../store/auth';

const getProjectIdForUser = () => {
  const user = useAuthStore.getState().user;
  return getProjectId(user?.id);
};

export interface CreateStoryStageInput {
  projectId?: string;
  name: string;
  description?: string | null;
  orderKey?: number;
  color?: string;
}

export interface UpdateStoryStageInput {
  name?: string;
  description?: string | null;
  orderKey?: number;
  color?: string;
}

export function useStoryStage() {
  const stageRepoRef = useRef(createStoryStageRepository());
  const stageRepo = stageRepoRef.current;

  const loadStages = useCallback(async (projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);
    return stageRepo.findAll(projectId);
  }, [stageRepo]);

  const getStageById = useCallback(async (id: string, projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);
    return stageRepo.findById(id);
  }, [stageRepo]);

  const createStage = useCallback(async (input: CreateStoryStageInput) => {
    const projectId = input.projectId ?? getProjectIdForUser();
    await initDatabase(projectId);

    // If orderKey not provided, get max and add 1
    const stages = await stageRepo.findAll(projectId);
    const maxOrder = stages.reduce((max, stage) => Math.max(max, stage.orderKey), 0);
    const orderKey = input.orderKey ?? maxOrder + 1;

    return stageRepo.create({
      projectId,
      name: input.name,
      descriptionJson: input.description ?? '{}',
      orderKey,
      startNodeId: '', // Default empty
      endNodeId: '', // Default empty
      color: input.color ?? '#000000',
    });
  }, [stageRepo]);

  const updateStage = useCallback(async (id: string, input: UpdateStoryStageInput, projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);

    // Map input to partial story stage
    const updates: Partial<StoryStage> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.orderKey !== undefined) updates.orderKey = input.orderKey;
    if (input.color !== undefined) updates.color = input.color;
    if (input.description !== undefined) updates.descriptionJson = input.description ?? '{}';

    return stageRepo.update(id, updates);
  }, [stageRepo]);

  const deleteStage = useCallback(async (id: string, projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);
    return stageRepo.delete(id);
  }, [stageRepo]);

  const reorderStage = useCallback(async (id: string, direction: 'up' | 'down', projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);
    const stages = await stageRepo.findAll(projectId);
    const sortedStages = stages.slice().sort((a, b) => a.orderKey - b.orderKey);
    const index = sortedStages.findIndex((stage) => stage.id === id);

    if (index === -1) return;

    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= sortedStages.length) return;

    const current = sortedStages[index];
    const target = sortedStages[swapIndex];

    // Swap positions
    await stageRepo.update(current.id, { orderKey: target.orderKey });
    await stageRepo.update(target.id, { orderKey: current.orderKey });
  }, [stageRepo]);

  return useMemo(() => ({
    loadStages,
    getStageById,
    createStage,
    updateStage,
    deleteStage,
    reorderStage,
  }), [loadStages, getStageById, createStage, updateStage, deleteStage, reorderStage]);
}
