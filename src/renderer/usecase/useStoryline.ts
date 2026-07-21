import { useMemo, useCallback } from 'react';
import type { Storyline } from '../domain/storyline';
import { makeUniqueStorylineName } from '../domain/storyline';
import { createStorylineRepository } from '../sqlite-repo/storyline-repo';
import { createNodeStorylineLinkRepository } from '../sqlite-repo/node-storyline-link-repo';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import { useProjectStore } from '../store/project-store';
import { randomColor } from '../utils';
import { v7 as uuidv7 } from 'uuid';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import { withAtomicSyncTransaction } from './sync-helpers';
import { canUseFeature } from '../lib/feature-access';
import { eq } from 'drizzle-orm';
import {
  deleteEntityRelationsInTransaction,
  withoutRelationsForEntity,
} from './entity-relation-cleanup';

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
        // Project-unique name so the storyline is addressable by name (#11).
        name: makeUniqueStorylineName(input.name ?? '', existing, activeProjectId),
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
          return withAtomicSyncTransaction(activeProjectId, async (tx, sync) => {
            const storyline = await createStorylineRepository(
              activeProjectId,
              tx,
            ).createStoryline(newStoryline);
            const linkRepoTx = createNodeStorylineLinkRepository(activeProjectId, tx);
            for (const nodeId of orphanChapterIds) {
              await linkRepoTx.setPrimaryStoryline(nodeId, newStoryline.id);
            }

            await sync('storyline', 'create', storyline.id, activeProjectId, {
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
              await sync(
                'nodeStorylineLink',
                'create',
                nodeId,
                activeProjectId,
                { isPrimary: true },
                storyline.id,
              );
            }
            return storyline;
          });
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
        name:
          input.name !== undefined
            ? makeUniqueStorylineName(input.name, prevStorylines, activeProjectId, input.id)
            : existing.name,
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
          withAtomicSyncTransaction(activeProjectId, async (tx, sync) => {
            const storyline = await createStorylineRepository(
              activeProjectId,
              tx,
            ).updateStoryline(input.id, {
              name: updated.name,
              color: updated.color,
              summary: updated.summary,
              orderKey: updated.orderKey,
              contentJson: updated.contentJson,
              kvJson: updated.kvJson,
              nodeContentTemplateJson: updated.nodeContentTemplateJson,
              updatedAt: updated.updatedAt,
              projectId: activeProjectId,
            });
            await sync('storyline', 'update', storyline.id, activeProjectId, {
              name: storyline.name,
              color: storyline.color,
              summary: storyline.summary,
              orderKey: storyline.orderKey,
              contentJson: storyline.contentJson,
              kvJson: storyline.kvJson,
              nodeContentTemplateJson: storyline.nodeContentTemplateJson,
            });
            return storyline;
          }),
        onSuccess: (storyline) => {
          updateStorylineState(storyline.id, storyline);
        },
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
      await withAtomicSyncTransaction(activeProjectId, async (tx, sync) => {
        await createStorylineRepository(activeProjectId, tx).restoreStoryline(id);
        await sync('storyline', 'restore', id, activeProjectId);
      });
      const fresh = await repo.getStorylinesByProject();
      setStorylinesState(fresh);
    },
    [activeProjectId, ensureDb, setStorylinesState],
  );

  // Permanently delete an already-trashed storyline — the "立刻删除" path in
  // the trash UI. The hard delete fires the NodeStorylineLink FK cascade, so
  // any lingering link rows go with it. The storyline isn't in the active
  // store (soft-deleted), so there's nothing to mutate there.
  const purgeStoryline = useCallback(
    async (id: string): Promise<void> => {
      await ensureDb();
      await withAtomicSyncTransaction(activeProjectId, async (tx, sync) => {
        await deleteEntityRelationsInTransaction(
          tx,
          sync,
          activeProjectId,
          'storyline',
          id,
        );
        await createStorylineRepository(activeProjectId, tx).deleteStoryline(id);
        await sync('storyline', 'delete', id, activeProjectId);
      });
      const relations = useDataStore.getState().entityRelations;
      useDataStore
        .getState()
        .setEntityRelations(
          withoutRelationsForEntity(relations, activeProjectId, 'storyline', id),
        );
    },
    [activeProjectId, ensureDb],
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
      const previousRelations = useDataStore.getState().entityRelations;
      const remainingRelations = withoutRelationsForEntity(
        previousRelations,
        activeProjectId,
        'storyline',
        id,
      );
      // Nodes whose primary is this storyline — they go to 未归属 AND lose any
      // non-primary links too.
      const nodesGoingUnaffiliated = Object.entries(prevPrimaryStorylineByNode)
        .filter(([, slId]) => slId === id)
        .map(([nid]) => nid);
      const nodesLosingSecondaryMembership = (prevForwardMapping[id] ?? []).filter(
        (nodeId) => !nodesGoingUnaffiliated.includes(nodeId),
      );

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
          store.setEntityRelations(remainingRelations);
          removeStorylineState(id);
        },
        rollback: () => {
          const store = useDataStore.getState();
          setStorylinesState(prevStorylines);
          store.setStorylineNodeMapping(prevForwardMapping);
          store.setPrimaryStorylineByNode(prevPrimaryStorylineByNode);
          store.setEntityRelations(previousRelations);
          // setStorylineNodeMapping rebuilds the reverse map internally, so
          // restoring just the forward map (above) is enough.
        },
        effect: async () => {
          // Pro/Studio: soft-delete the storyline row, but permanently remove
          // both curated entity relations and storyline memberships. Restore
          // intentionally brings back only the entity itself.
          //
          // Free: full hard delete inside a transaction so FK cascade runs.
          await withAtomicSyncTransaction(activeProjectId, async (tx, sync) => {
            await deleteEntityRelationsInTransaction(
              tx,
              sync,
              activeProjectId,
              'storyline',
              id,
            );
            const { NodeStorylineLinkTable } = await import('../schema/drizzle');
            if (nodesGoingUnaffiliated.length > 0) {
              const { inArray } = await import('drizzle-orm');
              await tx
                .delete(NodeStorylineLinkTable)
                .where(inArray(NodeStorylineLinkTable.nodeId, nodesGoingUnaffiliated));
              for (const nid of nodesGoingUnaffiliated) {
                await sync('nodeStorylineLink', 'update', nid, activeProjectId, {
                  storylineIds: [],
                  primaryStorylineId: null,
                });
              }
            }
            // Soft-deleting a storyline does not trigger an FK cascade. Remove
            // every remaining secondary membership explicitly so a reload
            // cannot resurrect links that the optimistic store already hid.
            await tx
              .delete(NodeStorylineLinkTable)
              .where(eq(NodeStorylineLinkTable.storylineId, id));
            for (const nodeId of nodesLosingSecondaryMembership) {
              await sync(
                'nodeStorylineLink',
                'delete',
                nodeId,
                activeProjectId,
                undefined,
                id,
              );
            }
            const storylineRepoTx = createStorylineRepository(activeProjectId, tx);
            if (canUseFeature('trash')) {
              await storylineRepoTx.softDeleteStoryline(id);
              await sync('storyline', 'softDelete', id, activeProjectId);
            } else {
              await storylineRepoTx.deleteStoryline(id);
              await sync('storyline', 'delete', id, activeProjectId);
            }
          });
        },
      });
    },
    [
      removeStorylineState,
      ensureDb,
      getStorylinesState,
      setStorylinesState,
      activeProjectId,
      getStorylineNodeMappingState,
    ],
  );

  const addNodeToStoryline = useCallback(
    async (nodeId: string, storylineId: string): Promise<void> => {
      await ensureDb();
      // Invariant: a node that belongs to ≥1 storyline always has a primary.
      // When it has none yet, this new membership becomes the primary — so a
      // single-storyline chapter is never left in the degenerate "member but no
      // primary" state, which renders grouped under the lane with no color
      // stripe and simultaneously lingers in the 未归属 bucket.
      const prevPrimary = useDataStore.getState().primaryStorylineByNode[nodeId] ?? null;
      const makePrimary = prevPrimary == null;
      const prevMapping = cloneStorylineNodeMapping(getStorylineNodeMappingState());
      return withOptimisticUpdate({
        apply: () => {
          addNodeToStorylineMappingState(storylineId, nodeId);
          if (makePrimary) useDataStore.getState().setNodePrimaryStoryline(nodeId, storylineId);
        },
        rollback: () => {
          setStorylineNodeMappingState(prevMapping);
          if (makePrimary) useDataStore.getState().setNodePrimaryStoryline(nodeId, prevPrimary);
        },
        effect: () =>
          withAtomicSyncTransaction(activeProjectId, async (tx, sync) => {
            const result = await createNodeStorylineLinkRepository(
              activeProjectId,
              tx,
            ).addNodeToStoryline(nodeId, storylineId, { isPrimary: makePrimary });
            await sync(
              'nodeStorylineLink',
              'create',
              nodeId,
              activeProjectId,
              { isPrimary: makePrimary },
              storylineId,
            );
            return result;
          }),
      });
    },
    [
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
        effect: () =>
          withAtomicSyncTransaction(activeProjectId, async (tx, sync) => {
            const result = await createNodeStorylineLinkRepository(
              activeProjectId,
              tx,
            ).removeNodeFromStoryline(nodeId, storylineId);
            await sync(
              'nodeStorylineLink',
              'delete',
              nodeId,
              activeProjectId,
              undefined,
              storylineId,
            );
            return result;
          }),
      });
    },
    [
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
      let primaryStorylineId =
        options && 'primaryStorylineId' in options
          ? options.primaryStorylineId ?? null
          : currentPrimary;
      // Invariant: membership in ≥1 storyline implies a primary. If we'd land
      // the node into storylines with no primary at all (e.g. a 未归属 chapter
      // assigned via a path that doesn't name a main), pin the first as primary
      // so it isn't left grouped-but-colorless / stuck in 未归属.
      if (primaryStorylineId == null && storylineIds.length > 0) {
        primaryStorylineId = storylineIds[0];
      }
      const effectiveIds: string[] =
        primaryStorylineId && !storylineIds.includes(primaryStorylineId)
          ? [primaryStorylineId, ...storylineIds]
          : storylineIds;
      const prevMapping = cloneStorylineNodeMapping(getStorylineNodeMappingState());
      // Keep the in-memory primary in lockstep with the DB write so the leading
      // stripe updates immediately (e.g. cross-storyline drag), not only after
      // the next sync/reload.
      const primaryChanged = primaryStorylineId !== currentPrimary;
      return withOptimisticUpdate({
        apply: () => {
          setNodeStorylinesMappingState(nodeId, effectiveIds);
          if (primaryChanged)
            useDataStore.getState().setNodePrimaryStoryline(nodeId, primaryStorylineId);
        },
        rollback: () => {
          setStorylineNodeMappingState(prevMapping);
          if (primaryChanged)
            useDataStore.getState().setNodePrimaryStoryline(nodeId, currentPrimary);
        },
        effect: () =>
          withAtomicSyncTransaction(activeProjectId, async (tx, sync) => {
            const result = await createNodeStorylineLinkRepository(
              activeProjectId,
              tx,
            ).setNodeStorylines(nodeId, effectiveIds, { primaryStorylineId });
            await sync('nodeStorylineLink', 'update', nodeId, activeProjectId, {
              storylineIds: effectiveIds,
              primaryStorylineId,
            });
            return result;
          }),
      });
    },
    [
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
      purgeStoryline,
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
      purgeStoryline,
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
