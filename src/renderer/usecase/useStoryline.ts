import { useMemo, useCallback } from 'react';
import type { Storyline } from '../domain/storyline';
import type { BookNode } from '../domain/book-node';
import { createStorylineRepository } from '../sqlite-repo/storyline-repo';
import { createNodeStorylineLinkRepository } from '../sqlite-repo/node-storyline-link-repo';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import { useDataStore } from '../store/data-store';
import { randomColor } from '../utils';
import { v7 as uuidv7 } from 'uuid';
import { initDatabase, getDb } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import {
  syncStorylineCreate,
  syncStorylineUpdate,
  syncStorylineDelete,
  syncNodeUpdate,
  syncNodeStorylineLinkCreate,
  syncNodeStorylineLinkDelete,
  syncNodeStorylinesSet,
} from './sync-helpers';

export class StorylineHasMainReferencesError extends Error {
  constructor(
    public readonly storylineId: string,
    public readonly affectedNodeIds: string[],
  ) {
    super(
      `Storyline ${storylineId} is the main storyline of ${affectedNodeIds.length} node(s); pass reassignMainTo to delete.`,
    );
    this.name = 'StorylineHasMainReferencesError';
  }
}
import LogLevel from 'loglevel';
const log = LogLevel.getLogger('useStoryline');
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
};

export type UpdateStorylineInput = {
  id: string;
  name?: string;
  color?: string;
  summary?: string;
  orderKey?: number;
  descriptionJson?: string;
};

export interface UseStorylineContext {
  projectId: string;
  userId: string;
}

export function useStoryline({ projectId, userId }: UseStorylineContext) {
  const activeProjectId = projectId;
  if (!activeProjectId) {
    throw new Error('useStoryline requires a projectId');
  }
  if (!userId) {
    throw new Error('useStoryline requires a userId');
  }

  const repo = useMemo(() => createStorylineRepository(activeProjectId), [activeProjectId]);
  const linkRepo = useMemo(
    () => createNodeStorylineLinkRepository(activeProjectId),
    [activeProjectId],
  );
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

  const getStorylineNodeMappingState = useCallback(
    () => useDataStore.getState().storylineNodeMapping,
    [],
  );

  const setStorylineNodeMappingState = useCallback((mapping: Record<string, string[]>) => {
    useDataStore.getState().setStorylineNodeMapping(mapping);
  }, []);

  const cloneStorylineNodeMapping = useCallback((mapping: Record<string, string[]>) => {
    return Object.fromEntries(Object.entries(mapping).map(([key, value]) => [key, value.slice()]));
  }, []);

  const loadStorylines = useCallback(
    async (projectId?: string): Promise<Storyline[]> => {
      if (projectId && projectId !== activeProjectId) {
        throw new Error('Cannot load storylines for different projectId');
      }
      await ensureDb();
      const storylines = await repo.getStorylinesByProject();
      setStorylinesState(storylines);
      return storylines;
    },
    [repo, setStorylinesState, activeProjectId, ensureDb],
  );

  const createStoryline = useCallback(
    async (input: CreateStorylineInput): Promise<Storyline> => {
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
          console.log('Storyline created successfully:', storyline);
          const current = getStorylinesState();
          setStorylinesState(current.map((sl) => (sl.id === storyline.id ? storyline : sl)));
        },
        sync: (storyline) =>
          syncStorylineCreate(storyline.id, activeProjectId, {
            id: storyline.id,
            name: storyline.name,
            color: storyline.color,
            summary: storyline.summary,
            orderKey: storyline.orderKey,
            descriptionJson: storyline.descriptionJson,
          }),
      });
    },
    [repo, addStorylineState, activeProjectId, ensureDb, getStorylinesState, setStorylinesState],
  );

  const getStorylineById = useCallback(
    async (id: string): Promise<Storyline | null> => {
      await ensureDb();
      return repo.getStorylineById(id);
    },
    [repo, ensureDb],
  );

  const getStorylinesByProject = useCallback(
    async (projectId?: string): Promise<Storyline[]> => {
      if (projectId && projectId !== activeProjectId) {
        throw new Error('Cannot get storylines for different projectId');
      }
      await ensureDb();
      return repo.getStorylinesByProject();
    },
    [repo, ensureDb, activeProjectId],
  );

  const updateStoryline = useCallback(
    async (input: UpdateStorylineInput): Promise<Storyline> => {
      log.debug(`input is: `, input);
      await ensureDb();
      const now = new Date().toISOString();
      const prevStorylines = getStorylinesState().slice();
      const existing =
        prevStorylines.find((sl) => sl.id === input.id) ?? (await repo.getStorylineById(input.id));
      if (!existing) {
        throw new Error(`Storyline ${input.id} not found`);
      }

      const updated: Storyline = {
        ...existing,
        name: input.name ?? existing.name,
        color: input.color ?? existing.color,
        summary: input.summary ?? existing.summary,
        orderKey: input.orderKey ?? existing.orderKey,
        descriptionJson: input.descriptionJson ?? existing.descriptionJson,
        updatedAt: now,
      };
      log.debug(`updated storyline is: `, updated);
      return withOptimisticUpdate({
        apply: () => updateStorylineState(input.id, updated),
        rollback: () => setStorylinesState(prevStorylines),
        effect: () =>
          repo.updateStoryline(input.id, {
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
        sync: (storyline) =>
          syncStorylineUpdate(storyline.id, activeProjectId, {
            name: storyline.name,
            color: storyline.color,
            summary: storyline.summary,
            orderKey: storyline.orderKey,
            descriptionJson: storyline.descriptionJson,
          }),
      });
    },
    [repo, updateStorylineState, activeProjectId, ensureDb, getStorylinesState, setStorylinesState],
  );

  const deleteStoryline = useCallback(
    async (id: string, opts?: { reassignMainTo?: string }): Promise<void> => {
      await ensureDb();
      const prevStorylines = getStorylinesState().slice();

      if (!prevStorylines.some((sl) => sl.id === id)) {
        return;
      }
      if (prevStorylines.length <= 1) {
        throw new Error('Cannot delete the last storyline in the project.');
      }
      if (opts?.reassignMainTo === id) {
        throw new Error('Reassign target cannot be the storyline being deleted.');
      }

      const prevNodes = useDataStore.getState().bookNodes.slice();
      const affectedNodes = prevNodes.filter((n) => n.mainStorylineId === id);
      const reassignTo = opts?.reassignMainTo;

      if (affectedNodes.length > 0 && !reassignTo) {
        throw new StorylineHasMainReferencesError(
          id,
          affectedNodes.map((n) => n.id),
        );
      }
      if (reassignTo && !prevStorylines.some((sl) => sl.id === reassignTo)) {
        throw new Error(`Reassign target storyline ${reassignTo} not found in project.`);
      }

      const now = new Date().toISOString();
      const nextNodes: BookNode[] = reassignTo
        ? prevNodes.map((n) =>
            n.mainStorylineId === id ? { ...n, mainStorylineId: reassignTo, updatedAt: now } : n,
          )
        : prevNodes;

      return withOptimisticUpdate({
        apply: () => {
          if (reassignTo) useDataStore.getState().setBookNodes(nextNodes);
          removeStorylineState(id);
        },
        rollback: () => {
          setStorylinesState(prevStorylines);
          if (reassignTo) useDataStore.getState().setBookNodes(prevNodes);
        },
        effect: async () => {
          await getDb().transaction(async (tx) => {
            if (reassignTo && affectedNodes.length > 0) {
              const nodeRepoTx = createBookNodeSqliteRepository(activeProjectId, tx);
              for (const node of affectedNodes) {
                await nodeRepoTx.update(node.id, { mainStorylineId: reassignTo, updatedAt: now });
              }
            }
            const storylineRepoTx = createStorylineRepository(activeProjectId, tx);
            await storylineRepoTx.deleteStoryline(id);
          });
        },
        sync: () => {
          if (reassignTo) {
            affectedNodes.forEach((n) =>
              syncNodeUpdate(n.id, activeProjectId, { mainStorylineId: reassignTo }),
            );
          }
          syncStorylineDelete(id, activeProjectId);
        },
      });
    },
    [removeStorylineState, ensureDb, getStorylinesState, setStorylinesState, activeProjectId],
  );

  const addNodeToStoryline = useCallback(
    async (nodeId: string, storylineId: string): Promise<void> => {
      await ensureDb();
      const prevMapping = cloneStorylineNodeMapping(getStorylineNodeMappingState());
      return withOptimisticUpdate({
        apply: () => addNodeToStorylineMappingState(storylineId, nodeId),
        rollback: () => setStorylineNodeMappingState(prevMapping),
        effect: () => linkRepo.addNodeToStoryline(nodeId, storylineId),
        sync: () => syncNodeStorylineLinkCreate(nodeId, storylineId, activeProjectId),
      });
    },
    [
      linkRepo,
      addNodeToStorylineMappingState,
      ensureDb,
      cloneStorylineNodeMapping,
      getStorylineNodeMappingState,
      setStorylineNodeMappingState,
      activeProjectId,
    ],
  );

  const removeNodeFromStoryline = useCallback(
    async (nodeId: string, storylineId: string): Promise<void> => {
      await ensureDb();
      const prevMapping = cloneStorylineNodeMapping(getStorylineNodeMappingState());
      return withOptimisticUpdate({
        apply: () => removeNodeFromStorylineMappingState(storylineId, nodeId),
        rollback: () => setStorylineNodeMappingState(prevMapping),
        effect: () => linkRepo.removeNodeFromStoryline(nodeId, storylineId),
        sync: () => syncNodeStorylineLinkDelete(nodeId, storylineId, activeProjectId),
      });
    },
    [
      linkRepo,
      removeNodeFromStorylineMappingState,
      ensureDb,
      cloneStorylineNodeMapping,
      getStorylineNodeMappingState,
      setStorylineNodeMappingState,
      activeProjectId,
    ],
  );

  const getStorylinesByNode = useCallback(
    async (nodeId: string): Promise<Storyline[]> => {
      await ensureDb();
      return linkRepo.getStorylinesByNode(nodeId);
    },
    [linkRepo, ensureDb],
  );

  const getStorylinesByNodeIds = useCallback(
    async (nodeIds: string[]): Promise<Record<string, Storyline[]>> => {
      await ensureDb();
      return linkRepo.getStorylinesByNodeIds(nodeIds);
    },
    [linkRepo, ensureDb],
  );

  const getNodeIdsByStoryline = useCallback(
    async (storylineId: string): Promise<string[]> => {
      await ensureDb();
      return linkRepo.getNodeIdsByStoryline(storylineId);
    },
    [linkRepo, ensureDb],
  );

  const setNodeStorylines = useCallback(
    async (nodeId: string, storylineIds: string[]): Promise<void> => {
      await ensureDb();
      const prevMapping = cloneStorylineNodeMapping(getStorylineNodeMappingState());
      return withOptimisticUpdate({
        apply: () => setNodeStorylinesMappingState(nodeId, storylineIds),
        rollback: () => setStorylineNodeMappingState(prevMapping),
        effect: () => linkRepo.setNodeStorylines(nodeId, storylineIds),
        sync: () => syncNodeStorylinesSet(nodeId, activeProjectId, storylineIds),
      });
    },
    [
      linkRepo,
      setNodeStorylinesMappingState,
      ensureDb,
      cloneStorylineNodeMapping,
      getStorylineNodeMappingState,
      setStorylineNodeMappingState,
      activeProjectId,
    ],
  );

  return useMemo(
    () => ({
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
    }),
    [
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
    ],
  );
}
