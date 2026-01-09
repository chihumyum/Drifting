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

  const loadStorylines = useCallback(async (projectId: string): Promise<Storyline[]> => {
    const storylines = await repo.getStorylinesByProject(projectId);
    setStorylinesState(storylines);
    return storylines;
  }, [repo, setStorylinesState]);

  const createStoryline = useCallback(async (input: CreateStorylineInput): Promise<Storyline> => {
    return repo.createStoryline(input);
  }, [repo]);

  const getStorylineById = useCallback(async (id: string): Promise<Storyline | null> => {
    return repo.getStorylineById(id);
  }, [repo]);

  const getStorylinesByProject = useCallback(async (projectId: string): Promise<Storyline[]> => {
    return repo.getStorylinesByProject(projectId);
  }, [repo]);

  const updateStoryline = useCallback(async (input: UpdateStorylineInput): Promise<Storyline> => {
    return repo.updateStoryline(input);
  }, [repo]);

  const deleteStoryline = useCallback(async (id: string): Promise<void> => {
    return repo.deleteStoryline(id);
  }, [repo]);

  const addNodeToStoryline = useCallback(async (nodeId: string, storylineId: string): Promise<void> => {
    return repo.addNodeToStoryline(nodeId, storylineId);
  }, [repo]);

  const removeNodeFromStoryline = useCallback(async (nodeId: string, storylineId: string): Promise<void> => {
    return repo.removeNodeFromStoryline(nodeId, storylineId);
  }, [repo]);

  const getStorylinesByNode = useCallback(async (nodeId: string): Promise<Storyline[]> => {
    return repo.getStorylinesByNode(nodeId);
  }, [repo]);

  const getNodeIdsByStoryline = useCallback(async (storylineId: string): Promise<string[]> => {
    return repo.getNodeIdsByStoryline(storylineId);
  }, [repo]);

  const setNodeStorylines = useCallback(async (nodeId: string, storylineIds: string[]): Promise<void> => {
    return repo.setNodeStorylines(nodeId, storylineIds);
  }, [repo]);

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
