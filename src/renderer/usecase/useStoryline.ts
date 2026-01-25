import { useMemo, useCallback } from 'react';
import type { Storyline } from '../domain/storyline';
import { createStorylineRepository } from '../sqlite-repo/storyline-repo';
import { createNodeStorylineLinkRepository } from '../sqlite-repo/node-storyline-link-repo';
import { useDataStore } from '../store/data-store';
import { useAuthStore } from '../store/auth';
import { useParams } from 'react-router-dom';
import { randomColor } from '../utils';
import { v7 as uuidv7 } from 'uuid';
import loglevel from "loglevel";
import type { UpdateStorylineInput } from '../services';

const log = loglevel.getLogger("UseStoryline");
log.setLevel(loglevel.levels.WARN);
export type CreateStorylineInput = {
  // since projectId and user are got from store. 
  // maybe we don't need these?
  projectId?: string;
  orderKey?: number;

}



// TODO: get project & user from store
export function useStoryline() {
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const { user } = useAuthStore.getState();
  // repositories are bound to route projectId. do we really need to store projectid here too?
  const activeProjectId = routeProjectId;
  if (!activeProjectId) {
    throw new Error("useStoryline must be used within a project route");
  }
  if (!user) {
    throw new Error("useStoryline requires authenticated user");
  }

  const repo = useMemo(() => createStorylineRepository(activeProjectId), [activeProjectId]);
  const linkRepo = useMemo(() => createNodeStorylineLinkRepository(activeProjectId), [activeProjectId]);

  const setStorylinesState = useCallback((storylines: Storyline[]) => {
    useDataStore.getState().setStorylines(storylines);
  }, []);

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

  const loadStorylines = useCallback(async (projectId?: string): Promise<Storyline[]> => {
    if (projectId && projectId !== activeProjectId) {
      throw new Error('Cannot load storylines for different projectId');
    }
    const storylines = await repo.getStorylinesByProject();
    setStorylinesState(storylines);
    return storylines;
  }, [repo, setStorylinesState, activeProjectId]);

  const createStoryline = useCallback(async (input: CreateStorylineInput): Promise<Storyline> => {
    if (input.projectId && input.projectId !== activeProjectId) {
      throw new Error('Cannot create storyline for different projectId');
    }
    const existing = await repo.getStorylinesByProject();
    const maxOrder = existing.reduce((max, sl) => Math.max(max, sl.orderKey), 0);
    const orderKey = input.orderKey ?? maxOrder + 1;
    const newStoryline = {
      id: uuidv7(),
      projectId: activeProjectId,
      name: 'New Storyline',
      color: randomColor(),
      summary: '',
      orderKey,
      descriptionJson: '{}',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const storyline = await repo.createStoryline(newStoryline);
    addStorylineState(storyline);
    return storyline;
  }, [repo, addStorylineState, activeProjectId]);

  const getStorylineById = useCallback(async (id: string): Promise<Storyline | null> => {
    return repo.getStorylineById(id);
  }, [repo, activeProjectId]);

  const getStorylinesByProject = useCallback(async (projectId?: string): Promise<Storyline[]> => {
    if (projectId && projectId !== activeProjectId) {
      throw new Error('Cannot get storylines for different projectId');
    }
    return repo.getStorylinesByProject();
  }, [repo]);

  const updateStoryline = useCallback(async (input: UpdateStorylineInput): Promise<Storyline> => {
    const now = new Date().toISOString();
    const storyline = await repo.updateStoryline(input.id, {
      name: input.name,
      color: input.color,
      summary: input.summary,
      orderKey: input.orderKey,
      descriptionJson: input.pmJson,
      updatedAt: now,
      projectId: activeProjectId,
    });
    updateStorylineState(storyline.id, storyline);
    return storyline;
  }, [repo, updateStorylineState, activeProjectId]);

  const deleteStoryline = useCallback(async (id: string): Promise<void> => {
    await repo.deleteStoryline(id);
    removeStorylineState(id);
  }, [repo, removeStorylineState]);

  const addNodeToStoryline = useCallback(async (nodeId: string, storylineId: string): Promise<void> => {
    await linkRepo.addNodeToStoryline(nodeId, storylineId);
    addNodeToStorylineMappingState(storylineId, nodeId);
  }, [linkRepo, addNodeToStorylineMappingState]);

  const removeNodeFromStoryline = useCallback(async (nodeId: string, storylineId: string): Promise<void> => {
    await linkRepo.removeNodeFromStoryline(nodeId, storylineId);
    removeNodeFromStorylineMappingState(storylineId, nodeId);
  }, [linkRepo, removeNodeFromStorylineMappingState]);

  const getStorylinesByNode = useCallback(async (nodeId: string): Promise<Storyline[]> => {
    return linkRepo.getStorylinesByNode(nodeId);
  }, [linkRepo]);

  const getNodeIdsByStoryline = useCallback(async (storylineId: string): Promise<string[]> => {
    return linkRepo.getNodeIdsByStoryline(storylineId);
  }, [linkRepo]);

  const setNodeStorylines = useCallback(async (nodeId: string, storylineIds: string[]): Promise<void> => {
    await linkRepo.setNodeStorylines(nodeId, storylineIds);
    setNodeStorylinesMappingState(nodeId, storylineIds);
  }, [linkRepo, setNodeStorylinesMappingState]);

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
    getNodeIdsByStoryline,
    setNodeStorylines,
  ]);
}
