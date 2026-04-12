import { useMemo, useRef, useCallback } from 'react';
import { createStoryStageRepository } from '../sqlite-repo/story-stage-repo';
import { StoryStage } from '../domain/storystage';
import { initDatabase } from '../lib/db';
import { syncStageCreate, syncStageUpdate, syncStageDelete } from './sync-helpers';

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

export interface UseStoryStageContext {
  projectId: string;
  userId: string;
}

export function useStoryStage({ projectId, userId }: UseStoryStageContext) {
  const activeProjectId = projectId;
  if (!activeProjectId) {
    throw new Error('useStoryStage requires a projectId');
  }
  if (!userId) {
    throw new Error('useStoryStage requires a userId');
  }
  const stageRepoRef = useRef(createStoryStageRepository());
  const stageRepo = stageRepoRef.current;
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const loadStages = useCallback(async (projectId?: string) => {
    const pid = projectId ?? activeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to load stages');
    }
    await ensureDb();
    return stageRepo.findAll(pid);
  }, [stageRepo, activeProjectId, ensureDb]);

  const getStageById = useCallback(async (id: string, projectId?: string) => {
    const pid = projectId ?? activeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to get stage');
    }
    await ensureDb();
    return stageRepo.findById(id);
  }, [stageRepo, activeProjectId, ensureDb]);

  const createStage = useCallback(async (input: CreateStoryStageInput) => {
    const projectId = input.projectId ?? activeProjectId;
    if (!projectId) {
      throw new Error('Project ID is required to create stage');
    }
    await ensureDb();

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
    }).then(created => {
      syncStageCreate(created.id, projectId, {
        id: created.id, name: created.name, descriptionJson: created.descriptionJson,
        orderKey: created.orderKey, color: created.color,
      });
      return created;
    });
  }, [stageRepo, activeProjectId, ensureDb]);

  const updateStage = useCallback(async (id: string, input: UpdateStoryStageInput, projectId?: string) => {
    const pid = projectId ?? activeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to update stage');
    }
    await ensureDb();

    // Map input to partial story stage
    const updates: Partial<StoryStage> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.orderKey !== undefined) updates.orderKey = input.orderKey;
    if (input.color !== undefined) updates.color = input.color;
    if (input.description !== undefined) updates.descriptionJson = input.description ?? '{}';

    return stageRepo.update(id, updates).then(updated => {
      syncStageUpdate(id, pid, updates as Record<string, unknown>);
      return updated;
    });
  }, [stageRepo, activeProjectId, ensureDb]);

  const deleteStage = useCallback(async (id: string, projectId?: string) => {
    const pid = projectId ?? activeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to delete stage');
    }
    await ensureDb();
    const result = await stageRepo.delete(id);
    syncStageDelete(id, pid);
    return result;
  }, [stageRepo, activeProjectId, ensureDb]);

  const reorderStage = useCallback(async (id: string, direction: 'up' | 'down', projectId?: string) => {
    const pid = projectId ?? activeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to reorder stage');
    }
    await ensureDb();
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
    syncStageUpdate(current.id, pid, { orderKey: target.orderKey });
    syncStageUpdate(target.id, pid, { orderKey: current.orderKey });
  }, [stageRepo, activeProjectId, ensureDb]);

  return useMemo(() => ({
    loadStages,
    getStageById,
    createStage,
    updateStage,
    deleteStage,
    reorderStage,
  }), [loadStages, getStageById, createStage, updateStage, deleteStage, reorderStage]);
}
