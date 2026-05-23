import { useMemo, useCallback } from 'react';
import type { Storyline } from '../domain/storyline';
import type { BookNode } from '../domain/book-node';
import { normalizeBookNode } from '../domain/book-node';
import { createStorylineRepository } from '../sqlite-repo/storyline-repo';
import { createNodeStorylineLinkRepository } from '../sqlite-repo/node-storyline-link-repo';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import { useDataStore } from '../store/data-store';
import { useProjectStore } from '../store/project-store';
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
  kvJson?: string;
  nodeContentTemplateJson?: string;
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

  const loadNodeStorylineMapping = useCallback(async (): Promise<void> => {
    await ensureDb();
    const nodeIds = useDataStore.getState().bookNodes.map((n) => n.id);
    if (nodeIds.length === 0) {
      setStorylineNodeMappingState({});
      return;
    }
    const grouped = await linkRepo.getStorylinesByNodeIds(nodeIds);
    const forward: Record<string, string[]> = {};
    Object.entries(grouped).forEach(([nodeId, storylines]) => {
      storylines.forEach((sl) => {
        const arr = forward[sl.id] || [];
        if (!arr.includes(nodeId)) forward[sl.id] = [...arr, nodeId];
      });
    });
    setStorylineNodeMappingState(forward);
  }, [linkRepo, ensureDb, setStorylineNodeMappingState]);

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
      // Seed this storyline's kvJson from the parent project's template. We
      // read the template off the project store rather than re-querying so
      // the storyline picks up whatever the user has typed in the template
      // editor, even if the project row hasn't synced back from the server
      // yet. Falls back to an empty list if the project isn't loaded.
      const currentProject = useProjectStore.getState().currentProject;
      const seededKvJson =
        currentProject?.id === activeProjectId
          ? currentProject.storylineTemplateKvJson?.trim() || '[]'
          : '[]';
      const newStoryline: Storyline = {
        id: uuidv7(),
        projectId: activeProjectId,
        name: input.name?.trim() || 'New Storyline',
        color: input.color ?? randomColor(),
        summary: input.summary ?? '',
        orderKey,
        descriptionJson: DEFAULT_TIPTAP_DOC_JSON,
        kvJson: seededKvJson,
        nodeContentTemplateJson: '{}',
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
            kvJson: storyline.kvJson,
            nodeContentTemplateJson: storyline.nodeContentTemplateJson,
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
        kvJson: input.kvJson ?? existing.kvJson,
        nodeContentTemplateJson:
          input.nodeContentTemplateJson ?? existing.nodeContentTemplateJson,
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
            kvJson: updated.kvJson,
            nodeContentTemplateJson: updated.nodeContentTemplateJson,
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
            kvJson: storyline.kvJson,
            nodeContentTemplateJson: storyline.nodeContentTemplateJson,
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
      if (opts?.reassignMainTo === id) {
        throw new Error('Reassign target cannot be the storyline being deleted.');
      }
      if (opts?.reassignMainTo && !prevStorylines.some((sl) => sl.id === opts.reassignMainTo)) {
        throw new Error(`Reassign target storyline ${opts.reassignMainTo} not found in project.`);
      }

      const prevNodes = useDataStore.getState().bookNodes.slice();
      const prevForwardMapping = getStorylineNodeMappingState();
      const reverseMapping = cloneStorylineNodeMapping(prevForwardMapping);
      const affectedNodes = prevNodes.filter((n) => n.mainStorylineId === id);

      // Resolve per-node fallback main:
      //   - explicit reassignMainTo (if given), else
      //   - any other storyline this node still belongs to, else
      //   - null → node becomes a drift node
      const otherStorylineIds = (nodeId: string): string[] => {
        const out: string[] = [];
        Object.entries(prevForwardMapping).forEach(([slId, nodeIds]) => {
          if (slId !== id && nodeIds.includes(nodeId)) out.push(slId);
        });
        return out;
      };

      const now = new Date().toISOString();
      type Reassignment = { nodeId: string; newMain: string | null };
      const reassignments: Reassignment[] = affectedNodes.map((n) => {
        if (opts?.reassignMainTo) return { nodeId: n.id, newMain: opts.reassignMainTo };
        const others = otherStorylineIds(n.id);
        return { nodeId: n.id, newMain: others[0] ?? null };
      });

      const reassignByNode = new Map(reassignments.map((r) => [r.nodeId, r.newMain]));
      // When the storyline is being deleted and a node loses its last
      // storyline membership, reassignByNode maps it to null — flipping a
      // chapter into a drift. `normalizeBookNode` coerces the merged record
      // to the correct discriminated-union variant (drift loses bookOrder,
      // gets DriftStatus) so downstream code keeps narrowing cleanly.
      const nextNodes: BookNode[] = prevNodes.map((n) => {
        if (!reassignByNode.has(n.id)) return n;
        return normalizeBookNode({
          ...n,
          mainStorylineId: reassignByNode.get(n.id) ?? null,
          updatedAt: now,
        });
      });

      return withOptimisticUpdate({
        apply: () => {
          useDataStore.getState().setBookNodes(nextNodes);
          removeStorylineState(id);
        },
        rollback: () => {
          setStorylinesState(prevStorylines);
          useDataStore.getState().setBookNodes(prevNodes);
          setStorylineNodeMappingState(reverseMapping);
        },
        effect: async () => {
          await getDb().transaction(async (tx) => {
            const nodeRepoTx = createBookNodeSqliteRepository(activeProjectId, tx);
            for (const r of reassignments) {
              await nodeRepoTx.update(r.nodeId, { mainStorylineId: r.newMain, updatedAt: now });
            }
            const storylineRepoTx = createStorylineRepository(activeProjectId, tx);
            // FK: the storyline → node_storyline_link rows cascade; the
            // book_node.main_storyline_id FK is ON DELETE SET NULL so any nodes
            // we missed degrade safely to drift instead of blocking the delete.
            await storylineRepoTx.deleteStoryline(id);
          });
        },
        sync: () => {
          reassignments.forEach((r) =>
            syncNodeUpdate(r.nodeId, activeProjectId, { mainStorylineId: r.newMain }),
          );
          syncStorylineDelete(id, activeProjectId);
        },
      });
    },
    [
      removeStorylineState,
      ensureDb,
      getStorylinesState,
      setStorylinesState,
      activeProjectId,
      cloneStorylineNodeMapping,
      getStorylineNodeMappingState,
      setStorylineNodeMappingState,
    ],
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
      const node = useDataStore.getState().bookNodes.find((n) => n.id === nodeId);
      if (node && node.mainStorylineId === storylineId) {
        throw new Error(
          `Cannot unlink node ${nodeId} from its main storyline. Change the main storyline first.`,
        );
      }
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
      const node = useDataStore.getState().bookNodes.find((n) => n.id === nodeId);
      // Auto-pin the node's main storyline into the membership set (drift nodes
      // have no main; pin nothing in that case).
      const effectiveIds: string[] =
        node && node.mainStorylineId && !storylineIds.includes(node.mainStorylineId)
          ? [node.mainStorylineId, ...storylineIds]
          : storylineIds;
      const prevMapping = cloneStorylineNodeMapping(getStorylineNodeMappingState());
      return withOptimisticUpdate({
        apply: () => setNodeStorylinesMappingState(nodeId, effectiveIds),
        rollback: () => setStorylineNodeMappingState(prevMapping),
        effect: () => linkRepo.setNodeStorylines(nodeId, effectiveIds),
        sync: () => syncNodeStorylinesSet(nodeId, activeProjectId, effectiveIds),
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
      loadNodeStorylineMapping,
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
      loadNodeStorylineMapping,
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
