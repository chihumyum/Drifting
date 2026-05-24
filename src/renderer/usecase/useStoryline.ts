import { useMemo, useCallback } from 'react';
import type { Storyline } from '../domain/storyline';
import { createStorylineRepository } from '../sqlite-repo/storyline-repo';
import { createNodeStorylineLinkRepository } from '../sqlite-repo/node-storyline-link-repo';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import { useProjectStore } from '../store/project-store';
import { randomColor } from '../utils';
import { v7 as uuidv7 } from 'uuid';
import { initDatabase, getDb } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import {
  syncStorylineCreate,
  syncStorylineUpdate,
  syncStorylineDelete,
  syncStorylineSoftDelete,
  syncStorylineRestore,
  syncNodeStorylineLinkCreate,
  syncNodeStorylineLinkDelete,
  syncNodeStorylinesSet,
} from './sync-helpers';
import { canUseFeature } from '../lib/feature-access';

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
  contentJson?: string;
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
        contentJson: DEFAULT_TIPTAP_DOC_JSON,
        kvJson: seededKvJson,
        nodeContentTemplateJson: '{}',
        createdAt: now,
        updatedAt: now,
      };

      const prevStorylines = getStorylinesState().slice();
      // First-storyline migration: when a project goes from 0 → 1 storyline,
      // all existing chapters are automatically pulled into the new storyline
      // as primary. This bridges "single-lane / default writing mode" → the
      // multi-storyline regime cleanly, without leaving chapters orphaned in
      // a 未归属 lane the user didn't ask for.
      const isFirstStoryline = prevStorylines.length === 0;
      const orphanChapterIds = isFirstStoryline
        ? useDataStore
            .getState()
            .bookNodes.filter((n) => n.kind === 'chapter')
            .map((n) => n.id)
        : [];

      return withOptimisticUpdate({
        apply: () => addStorylineState(newStoryline),
        rollback: () => setStorylinesState(prevStorylines),
        effect: async () => {
          await repo.createStoryline(newStoryline);
          if (orphanChapterIds.length > 0) {
            // Insert one link row per chapter with isPrimary=true. The link
            // repo's per-call setPrimaryStoryline demotes any existing primary
            // — there are none here (project was in 0-storyline mode), so the
            // demote step is a cheap no-op.
            const linkRepoTx = createNodeStorylineLinkRepository(activeProjectId);
            for (const nodeId of orphanChapterIds) {
              await linkRepoTx.setPrimaryStoryline(nodeId, newStoryline.id);
            }
          }
          return newStoryline;
        },
        onSuccess: (storyline) => {
          console.log('Storyline created successfully:', storyline);
          const current = getStorylinesState();
          setStorylinesState(current.map((sl) => (sl.id === storyline.id ? storyline : sl)));
          if (orphanChapterIds.length > 0) {
            const store = useDataStore.getState();
            // Update primaryStorylineByNode + storylineNodeMapping for the
            // newly-migrated chapters.
            const nextPrimary = { ...store.primaryStorylineByNode };
            for (const nid of orphanChapterIds) nextPrimary[nid] = storyline.id;
            store.setPrimaryStorylineByNode(nextPrimary);
            const nextForward = { ...store.storylineNodeMapping };
            nextForward[storyline.id] = orphanChapterIds.slice();
            store.setStorylineNodeMapping(nextForward);
          }
        },
        sync: (storyline) => {
          syncStorylineCreate(storyline.id, activeProjectId, {
            id: storyline.id,
            name: storyline.name,
            color: storyline.color,
            summary: storyline.summary,
            orderKey: storyline.orderKey,
            contentJson: storyline.contentJson,
            kvJson: storyline.kvJson,
            nodeContentTemplateJson: storyline.nodeContentTemplateJson,
          });
          for (const nodeId of orphanChapterIds) {
            syncNodeStorylineLinkCreate(nodeId, storyline.id, activeProjectId, {
              isPrimary: true,
            });
          }
        },
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
        contentJson: input.contentJson ?? existing.contentJson,
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
            contentJson: updated.contentJson,
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
            contentJson: storyline.contentJson,
            kvJson: storyline.kvJson,
            nodeContentTemplateJson: storyline.nodeContentTemplateJson,
          }),
      });
    },
    [repo, updateStorylineState, activeProjectId, ensureDb, getStorylinesState, setStorylinesState],
  );

  // Delete a storyline with the "chapter → 未归属" semantics:
  //   • Chapters whose PRIMARY storyline is the deleted one:
  //       - Lose the primary link.
  //       - All their OTHER (non-primary) storyline links are also cleared,
  //         per the project's "don't auto-fallback" rule. The chapter ends up
  //         in the 未归属 lane with its bookOrder preserved.
  //   • Chapters with only a non-primary link to the deleted storyline:
  //       - That single link is removed; primary stays untouched.
  // Drift nodes are unaffected (they never have storyline links). The book_node
  // row itself is never mutated — kind stays 'chapter', bookOrder is preserved.
  const restoreStoryline = useCallback(
    async (id: string): Promise<void> => {
      await ensureDb();
      const repo = createStorylineRepository(activeProjectId);
      await repo.restoreStoryline(id);
      syncStorylineRestore(id, activeProjectId);
      const fresh = await repo.getStorylinesByProject();
      setStorylinesState(fresh);
    },
    [activeProjectId, ensureDb, setStorylinesState],
  );

  const listTrashedStorylines = useCallback(async () => {
    await ensureDb();
    const repo = createStorylineRepository(activeProjectId);
    return await repo.getTrashedStorylines();
  }, [activeProjectId, ensureDb]);

  const deleteStoryline = useCallback(
    async (id: string): Promise<void> => {
      await ensureDb();
      const prevStorylines = getStorylinesState().slice();
      if (!prevStorylines.some((sl) => sl.id === id)) return;

      const prevPrimaryStorylineByNode = useDataStore.getState().primaryStorylineByNode;
      const prevForwardMapping = getStorylineNodeMappingState();
      const reverseMapping = cloneStorylineNodeMapping(prevForwardMapping);
      const prevNodeStorylineMapping = { ...useDataStore.getState().nodeStorylineMapping };

      // Nodes whose primary is this storyline — they go to 未归属 AND lose any
      // non-primary links too.
      const nodesGoingUnaffiliated = Object.entries(prevPrimaryStorylineByNode)
        .filter(([, slId]) => slId === id)
        .map(([nid]) => nid);

      // Drop any tabs pointing at this storyline first — by the time apply()
      // mutates the entity store the tab lookup would already render
      // "Untitled Storyline" for the leaf.
      useUiStore.getState().closeTabsForEntity(activeProjectId, { entityType: 'storyline', id });

      return withOptimisticUpdate({
        apply: () => {
          const store = useDataStore.getState();
          // Demote primary → null for affected chapters.
          const nextPrimary = { ...prevPrimaryStorylineByNode };
          for (const nid of nodesGoingUnaffiliated) nextPrimary[nid] = null;
          store.setPrimaryStorylineByNode(nextPrimary);
          // Clear the affected chapters' entire storyline membership (per the
          // "don't auto-fallback" rule) and also remove every other node's
          // link to the deleted storyline.
          const nextForward = { ...prevForwardMapping };
          delete nextForward[id];
          for (const nid of nodesGoingUnaffiliated) {
            // Make sure they don't appear under any storyline.
            for (const slId of Object.keys(nextForward)) {
              nextForward[slId] = nextForward[slId].filter((x) => x !== nid);
            }
          }
          store.setStorylineNodeMapping(nextForward);
          removeStorylineState(id);
        },
        rollback: () => {
          const store = useDataStore.getState();
          setStorylinesState(prevStorylines);
          store.setStorylineNodeMapping(prevForwardMapping);
          store.setPrimaryStorylineByNode(prevPrimaryStorylineByNode);
          // setStorylineNodeMapping rebuilds the reverse map internally, so
          // restoring just the forward map (above) is enough.
          void prevNodeStorylineMapping;
          void reverseMapping;
        },
        effect: async () => {
          // Pro/Studio: soft-delete only. The storyline disappears from list
          // queries but the row + its link rows linger (no FK cascade fires
          // because nothing is hard-deleted). We still wipe link rows for
          // chapters that go 未归属 — that's the "restore doesn't restore
          // relations" rule from the spec.
          //
          // Free: full hard delete inside a transaction so FK cascade runs.
          await getDb().transaction(async (tx) => {
            if (nodesGoingUnaffiliated.length > 0) {
              const { NodeStorylineLinkTable } = await import('../schema/drizzle');
              const { inArray } = await import('drizzle-orm');
              await tx
                .delete(NodeStorylineLinkTable)
                .where(inArray(NodeStorylineLinkTable.nodeId, nodesGoingUnaffiliated));
            }
            const storylineRepoTx = createStorylineRepository(activeProjectId, tx);
            if (canUseFeature('trash')) {
              await storylineRepoTx.softDeleteStoryline(id);
            } else {
              await storylineRepoTx.deleteStoryline(id);
            }
          });
        },
        sync: () => {
          for (const nid of nodesGoingUnaffiliated) {
            syncNodeStorylinesSet(nid, activeProjectId, [], { primaryStorylineId: null });
          }
          if (canUseFeature('trash')) {
            syncStorylineSoftDelete(id, activeProjectId);
          } else {
            syncStorylineDelete(id, activeProjectId);
          }
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
      const currentPrimary =
        useDataStore.getState().primaryStorylineByNode[nodeId] ?? null;
      if (currentPrimary === storylineId) {
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
    async (
      nodeId: string,
      storylineIds: string[],
      options?: { primaryStorylineId?: string | null },
    ): Promise<void> => {
      await ensureDb();
      // Resolve the primary: caller may pass an explicit override (used by
      // cross-storyline drag, where we want to swap memberships AND the
      // primary in one state apply to avoid a transient [source, target]
      // membership that flashes a cross-storyline dashed edge). Otherwise
      // auto-pin the current primary into the membership set so the
      // is_primary row survives the bulk replace.
      const currentPrimary =
        useDataStore.getState().primaryStorylineByNode[nodeId] ?? null;
      const primaryStorylineId =
        options && 'primaryStorylineId' in options
          ? options.primaryStorylineId ?? null
          : currentPrimary;
      const effectiveIds: string[] =
        primaryStorylineId && !storylineIds.includes(primaryStorylineId)
          ? [primaryStorylineId, ...storylineIds]
          : storylineIds;
      const prevMapping = cloneStorylineNodeMapping(getStorylineNodeMappingState());
      return withOptimisticUpdate({
        apply: () => setNodeStorylinesMappingState(nodeId, effectiveIds),
        rollback: () => setStorylineNodeMappingState(prevMapping),
        effect: () => linkRepo.setNodeStorylines(nodeId, effectiveIds, { primaryStorylineId }),
        sync: () =>
          syncNodeStorylinesSet(nodeId, activeProjectId, effectiveIds, { primaryStorylineId }),
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
      restoreStoryline,
      listTrashedStorylines,
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
      restoreStoryline,
      listTrashedStorylines,
      addNodeToStoryline,
      removeNodeFromStoryline,
      getStorylinesByNode,
      getStorylinesByNodeIds,
      getNodeIdsByStoryline,
      setNodeStorylines,
    ],
  );
}
