import { useMemo, useCallback } from 'react';
import type { Storyline } from '../domain/storyline';
import { createStorylineRepository } from '../sqlite-repo/storyline-repo';
import { createNodeStorylineLinkRepository } from '../sqlite-repo/node-storyline-link-repo';
import { useDataStore } from '../store/data-store';
import { randomColor } from '../utils';
import { v7 as uuidv7 } from 'uuid';
import type { UpdateStorylineInput } from '../services';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import {
  syncStorylineCreate, syncStorylineUpdate, syncStorylineDelete,
  syncNodeStorylineLinkCreate, syncNodeStorylineLinkDelete, syncNodeStorylinesSet,
} from './sync-helpers';
import LogLevel from 'loglevel';
const log = LogLevel.getLogger("useStoryline");
log.setLevel(LogLevel.levels.DEBUG);
log.setLevel(LogLevel.levels.WARN);

const DEFAULT_TIPTAP_DOC_JSON = JSON.stringify({
  type: 'doc',
  content: [],
});

export type CreateStorylineInput = {
  projectId?: string;
  name?: string;
  color?: string;
  summary?: string;
  orderKey?: number;
}

export interface UseStorylineContext {
  projectId: string;
  userId: string;
}

export function useStoryline({ projectId, userId }: UseStorylineContext) {
  const activeProjectId = projectId;
  if (!activeProjectId) {
    throw new Error("useStoryline requires a projectId");
  }
  if (!userId) {
    throw new Error("useStoryline requires a userId");
  }

  const repo = useMemo(() => createStorylineRepository(activeProjectId), [activeProjectId]);
  const linkRepo = useMemo(() => createNodeStorylineLinkRepository(activeProjectId), [activeProjectId]);
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const setStorylinesState = useCallback((storylines: Storyline[]) => {
    useDataStore.getState().setStorylines(storylines);
  }, []);

  const getStorylinesState = useCallback(() => useDataStore.getState().storylines, []);

  const addStorylineState = useCallback((storyline: Storyline) => {
    useDataStore.getState().addStoryline(storyline);
  }, []);

  const updateStorylineState = useCallback((id: string, updates: Partial<Storyline>) => {
    useDataStore.getState().updateStoryline(id, updates);
  }, []);

  const removeStorylineState = useCallback((id: string) => {
    useDataStore.getState().removeStoryline(id);
  }, []);

  const addNodeToStorylineMappingState = useCallback((storylineId: string, nodeId: string) => {
    useDataStore.getState().addNodeToStorylineMapping(storylineId, nodeId);
  }, []);

  const removeNodeFromStorylineMappingState = useCallback((storylineId: string, nodeId: string) => {
    useDataStore.getState().removeNodeFromStorylineMapping(storylineId, nodeId);
  }, []);

  const setNodeStorylinesMappingState = useCallback((nodeId: string, storylineIds: string[]) => {
    useDataStore.getState().setNodeStorylinesMapping(nodeId, storylineIds);
  }, []);

  const getStorylineNodeMappingState = useCallback(() => useDataStore.getState().storylineNodeMapping, []);

  const setStorylineNodeMappingState = useCallback((mapping: Record<string, string[]>) => {
    useDataStore.getState().setStorylineNodeMapping(mapping);
  }, []);

  const cloneStorylineNodeMapping = useCallback((mapping: Record<string, string[]>) => {
    return Object.fromEntries(
      Object.entries(mapping).map(([key, value]) => [key, value.slice()])
    );
  }, []);

  const loadStorylines = useCallback(async (projectId?: string): Promise<Storyline[]> => {
    if (projectId && projectId !== activeProjectId) {
      throw new Error('Cannot load storylines for different projectId');
    }
    await ensureDb();
    const storylines = await repo.getStorylinesByProject();
    setStorylinesState(storylines);
    return storylines;
  }, [repo, setStorylinesState, activeProjectId, ensureDb]);

  const createStoryline = useCallback(async (input: CreateStorylineInput): Promise<Storyline> => {
    if (input.projectId && input.projectId !== activeProjectId) {
      throw new Error('Cannot create storyline for different projectId');
    }
    await ensureDb();
    const existing = await repo.getStorylinesByProject();
    const maxOrder = existing.reduce((max, sl) => Math.max(max, sl.orderKey), 0);
    const orderKey = input.orderKey ?? maxOrder + 1;
    const now = new Date().toISOString();
    const newStoryline: Storyline = {
      id: uuidv7(),
      projectId: activeProjectId,
      name: input.name?.trim() || 'New Storyline',
      color: input.color ?? randomColor(),
      summary: input.summary ?? '',
      orderKey,
      descriptionJson: DEFAULT_TIPTAP_DOC_JSON,
      createdAt: now,
      updatedAt: now,
    };

    const prevStorylines = getStorylinesState().slice();
    return withOptimisticUpdate({
      apply: () => addStorylineState(newStoryline),
      rollback: () => setStorylinesState(prevStorylines),
      effect: () => repo.createStoryline(newStoryline),
      onSuccess: (storyline) => {
        console.log("Storyline created successfully:", storyline);
        const current = getStorylinesState();
        setStorylinesState(current.map(sl => (sl.id === storyline.id ? storyline : sl)));
      },
      sync: (storyline) => syncStorylineCreate(storyline.id, activeProjectId, {
        id: storyline.id, name: storyline.name, color: storyline.color,
        summary: storyline.summary, orderKey: storyline.orderKey,
        descriptionJson: storyline.descriptionJson,
      }),
    });
  }, [repo, addStorylineState, activeProjectId, ensureDb, getStorylinesState, setStorylinesState]);

  const getStorylineById = useCallback(async (id: string): Promise<Storyline | null> => {
    await ensureDb();
    return repo.getStorylineById(id);
  }, [repo, ensureDb]);

  const getStorylinesByProject = useCallback(async (projectId?: string): Promise<Storyline[]> => {
    if (projectId && projectId !== activeProjectId) {
      throw new Error('Cannot get storylines for different projectId');
    }
    await ensureDb();
    return repo.getStorylinesByProject();
  }, [repo, ensureDb, activeProjectId]);

  const updateStoryline = useCallback(async (input: UpdateStorylineInput): Promise<Storyline> => {
    log.debug(`input is: `, input);
    await ensureDb();
    const now = new Date().toISOString();
    const prevStorylines = getStorylinesState().slice();
    const existing = prevStorylines.find(sl => sl.id === input.id) ?? await repo.getStorylineById(input.id);
    if (!existing) {
      throw new Error(`Storyline ${input.id} not found`);
    }

    const updated: Storyline = {
      ...existing,
      name: input.name ?? existing.name,
      color: input.color ?? existing.color,
      summary: input.summary ?? existing.summary,
      orderKey: input.orderKey ?? existing.orderKey,
      descriptionJson: input.pmJson ?? existing.descriptionJson,
      updatedAt: now,
    };
    log.debug(`updated storyline is: `, updated);
    return withOptimisticUpdate({
      apply: () => updateStorylineState(input.id, updated),
      rollback: () => setStorylinesState(prevStorylines),
      effect: () => repo.updateStoryline(input.id, {
        name: updated.name,
        color: updated.color,
        summary: updated.summary,
        orderKey: updated.orderKey,
        descriptionJson: updated.descriptionJson,
        updatedAt: updated.updatedAt,
        projectId: activeProjectId,
      }),
      onSuccess: (storyline) => {
        updateStorylineState(storyline.id, storyline);
      },
      sync: (storyline) => syncStorylineUpdate(storyline.id, activeProjectId, {
        name: storyline.name, color: storyline.color, summary: storyline.summary,
        orderKey: storyline.orderKey, descriptionJson: storyline.descriptionJson,
      }),
    });
  }, [repo, updateStorylineState, activeProjectId, ensureDb, getStorylinesState, setStorylinesState]);

  const deleteStoryline = useCallback(async (id: string): Promise<void> => {
    await ensureDb();
    const prevStorylines = getStorylinesState().slice();
    return withOptimisticUpdate({
      apply: () => removeStorylineState(id),
      rollback: () => setStorylinesState(prevStorylines),
      effect: () => repo.deleteStoryline(id),
      sync: () => syncStorylineDelete(id, activeProjectId),
    });
  }, [repo, removeStorylineState, ensureDb, getStorylinesState, setStorylinesState, activeProjectId]);

  const addNodeToStoryline = useCallback(async (nodeId: string, storylineId: string): Promise<void> => {
    await ensureDb();
    const prevMapping = cloneStorylineNodeMapping(getStorylineNodeMappingState());
    return withOptimisticUpdate({
      apply: () => addNodeToStorylineMappingState(storylineId, nodeId),
      rollback: () => setStorylineNodeMappingState(prevMapping),
      effect: () => linkRepo.addNodeToStoryline(nodeId, storylineId),
      sync: () => syncNodeStorylineLinkCreate(nodeId, storylineId, activeProjectId),
    });
  }, [linkRepo, addNodeToStorylineMappingState, ensureDb, cloneStorylineNodeMapping, getStorylineNodeMappingState, setStorylineNodeMappingState, activeProjectId]);

  const removeNodeFromStoryline = useCallback(async (nodeId: string, storylineId: string): Promise<void> => {
    await ensureDb();
    const prevMapping = cloneStorylineNodeMapping(getStorylineNodeMappingState());
    return withOptimisticUpdate({
      apply: () => removeNodeFromStorylineMappingState(storylineId, nodeId),
      rollback: () => setStorylineNodeMappingState(prevMapping),
      effect: () => linkRepo.removeNodeFromStoryline(nodeId, storylineId),
      sync: () => syncNodeStorylineLinkDelete(nodeId, storylineId, activeProjectId),
    });
  }, [linkRepo, removeNodeFromStorylineMappingState, ensureDb, cloneStorylineNodeMapping, getStorylineNodeMappingState, setStorylineNodeMappingState, activeProjectId]);

  const getStorylinesByNode = useCallback(async (nodeId: string): Promise<Storyline[]> => {
    await ensureDb();
    return linkRepo.getStorylinesByNode(nodeId);
  }, [linkRepo, ensureDb]);

  const getStorylinesByNodeIds = useCallback(async (nodeIds: string[]): Promise<Record<string, Storyline[]>> => {
    await ensureDb();
    return linkRepo.getStorylinesByNodeIds(nodeIds);
  }, [linkRepo, ensureDb]);

  const getNodeIdsByStoryline = useCallback(async (storylineId: string): Promise<string[]> => {
    await ensureDb();
    return linkRepo.getNodeIdsByStoryline(storylineId);
  }, [linkRepo, ensureDb]);

  const setNodeStorylines = useCallback(async (nodeId: string, storylineIds: string[]): Promise<void> => {
    await ensureDb();
    const prevMapping = cloneStorylineNodeMapping(getStorylineNodeMappingState());
    return withOptimisticUpdate({
      apply: () => setNodeStorylinesMappingState(nodeId, storylineIds),
      rollback: () => setStorylineNodeMappingState(prevMapping),
      effect: () => linkRepo.setNodeStorylines(nodeId, storylineIds),
      sync: () => syncNodeStorylinesSet(nodeId, activeProjectId, storylineIds),
    });
  }, [linkRepo, setNodeStorylinesMappingState, ensureDb, cloneStorylineNodeMapping, getStorylineNodeMappingState, setStorylineNodeMappingState, activeProjectId]);

  return useMemo(() => ({
    loadStorylines,
    createStoryline,
    getStorylineById,
    getStorylinesByProject,
    updateStoryline,
    deleteStoryline,
    addNodeToStoryline,
    removeNodeFromStoryline,
    getStorylinesByNode,
    getStorylinesByNodeIds,
    getNodeIdsByStoryline,
    setNodeStorylines,
  }), [
    loadStorylines,
    createStoryline,
    getStorylineById,
    getStorylinesByProject,
    updateStoryline,
    deleteStoryline,
    addNodeToStoryline,
    removeNodeFromStoryline,
    getStorylinesByNode,
    getStorylinesByNodeIds,
    getNodeIdsByStoryline,
    setNodeStorylines,
  ]);
}
