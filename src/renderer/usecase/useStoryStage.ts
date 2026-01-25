import { useMemo, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { createStoryStageRepository } from '../sqlite-repo/story-stage-repo';
import { StoryStage } from '../domain/storystage';
import { initDatabase } from '../lib/db';
import { useAuthStore } from '../store/auth';

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
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const stageRepoRef = useRef(createStoryStageRepository());
  const stageRepo = stageRepoRef.current;

  const loadStages = useCallback(async (projectId?: string) => {
    const pid = projectId ?? routeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to load stages');
    }
    await initDatabase(pid);
    return stageRepo.findAll(pid);
  }, [stageRepo, routeProjectId]);

  const getStageById = useCallback(async (id: string, projectId?: string) => {
    const pid = projectId ?? routeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to get stage');
    }
    await initDatabase(pid);
    return stageRepo.findById(id);
  }, [stageRepo, routeProjectId]);

  const createStage = useCallback(async (input: CreateStoryStageInput) => {
    const projectId = input.projectId ?? routeProjectId;
    if (!projectId) {
      throw new Error('Project ID is required to create stage');
    }
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
      color: input.color ?? '#000000',
    });
  }, [stageRepo]);

  const updateStage = useCallback(async (id: string, input: UpdateStoryStageInput, projectId?: string) => {
    const pid = projectId ?? routeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to update stage');
    }
    await initDatabase(pid);

    // Map input to partial story stage
    const updates: Partial<StoryStage> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.orderKey !== undefined) updates.orderKey = input.orderKey;
    if (input.color !== undefined) updates.color = input.color;
    if (input.description !== undefined) updates.descriptionJson = input.description ?? '{}';

    return stageRepo.update(id, updates);
  }, [stageRepo, routeProjectId]);

  const deleteStage = useCallback(async (id: string, projectId?: string) => {
    const pid = projectId ?? routeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to delete stage');
    }
    await initDatabase(pid);
    return stageRepo.delete(id);
  }, [stageRepo, routeProjectId]);

  const reorderStage = useCallback(async (id: string, direction: 'up' | 'down', projectId?: string) => {
    const pid = projectId ?? routeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to reorder stage');
    }
    await initDatabase(pid);
    const stages = await stageRepo.findAll(pid);
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
  }, [stageRepo, routeProjectId]);

  return useMemo(() => ({
    loadStages,
    getStageById,
    createStage,
    updateStage,
    deleteStage,
    reorderStage,
  }), [loadStages, getStageById, createStage, updateStage, deleteStage, reorderStage]);
}
