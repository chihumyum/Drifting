import { useMemo, useRef, useCallback } from 'react';
import type { Storyline, CreateStorylineInput, UpdateStorylineInput } from '../domain/storyline';
import { StorylineSQLiteRepository } from '../repositories/storyline_sqlite';
import { useDataStore } from '../store/data-store';

export function useStoryline() {
  const repoRef = useRef(new StorylineSQLiteRepository());
  const repo = repoRef.current;
  
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

  const loadStorylines = useCallback(async (projectId: string): Promise<Storyline[]> => {
    const storylines = await repo.getStorylinesByProject(projectId);
    setStorylinesState(storylines);
    return storylines;
  }, [repo, setStorylinesState]);

  const createStoryline = useCallback(async (input: CreateStorylineInput): Promise<Storyline> => {
    const storyline = await repo.createStoryline(input);
    addStorylineState(storyline);
    return storyline;
  }, [repo, addStorylineState]);

  const getStorylineById = useCallback(async (id: string): Promise<Storyline | null> => {
    return repo.getStorylineById(id);
  }, [repo]);

  const getStorylinesByProject = useCallback(async (projectId: string): Promise<Storyline[]> => {
    return repo.getStorylinesByProject(projectId);
  }, [repo]);

  const updateStoryline = useCallback(async (input: UpdateStorylineInput): Promise<Storyline> => {
    const storyline = await repo.updateStoryline(input);
    updateStorylineState(storyline.id, storyline);
    return storyline;
  }, [repo, updateStorylineState]);

  const deleteStoryline = useCallback(async (id: string): Promise<void> => {
    await repo.deleteStoryline(id);
    removeStorylineState(id);
  }, [repo, removeStorylineState]);

  const addNodeToStoryline = useCallback(async (nodeId: string, storylineId: string): Promise<void> => {
    await repo.addNodeToStoryline(nodeId, storylineId);
    addNodeToStorylineMappingState(storylineId, nodeId);
  }, [repo, addNodeToStorylineMappingState]);

  const removeNodeFromStoryline = useCallback(async (nodeId: string, storylineId: string): Promise<void> => {
    await repo.removeNodeFromStoryline(nodeId, storylineId);
    removeNodeFromStorylineMappingState(storylineId, nodeId);
  }, [repo, removeNodeFromStorylineMappingState]);

  const getStorylinesByNode = useCallback(async (nodeId: string): Promise<Storyline[]> => {
    return repo.getStorylinesByNode(nodeId);
  }, [repo]);

  const getNodeIdsByStoryline = useCallback(async (storylineId: string): Promise<string[]> => {
    return repo.getNodeIdsByStoryline(storylineId);
  }, [repo]);

  const setNodeStorylines = useCallback(async (nodeId: string, storylineIds: string[]): Promise<void> => {
    await repo.setNodeStorylines(nodeId, storylineIds);
    setNodeStorylinesMappingState(nodeId, storylineIds);
  }, [repo, setNodeStorylinesMappingState]);

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
