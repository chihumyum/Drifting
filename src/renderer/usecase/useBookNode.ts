import { useCallback, useMemo, useRef } from 'react';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo.ts';
import { createBookContentRepository } from '../sqlite-repo/content-repo.ts';
import { createNodeStorylineLinkRepository } from '../sqlite-repo/node-storyline-link-repo.ts';
import type { BookNode } from '../domain/book-node.ts';
import { compareBookOrder, isChapter } from '../domain/book-node.ts';
import { initDatabase, getDb } from '../lib/db';
import { v7 as uuidv7 } from 'uuid';
import loglevel from 'loglevel';
import { withOptimisticUpdate } from './optimistic';
import {
  syncNodeCreate,
  syncNodeUpdate,
  syncNodeDelete,
  syncNodeSoftDelete,
  syncNodeRestore,
  syncNodeStorylineLinkCreate,
  syncNodeContentUpdate,
} from './sync-helpers';
import { canUseFeature } from '../lib/feature-access';

const log = loglevel.getLogger('UseBookNode');
log.setLevel(loglevel.levels.ERROR);

export interface CreateNodeUsecaseInput {
  // 'chapter' — sits on the reading-order axis, may or may not have a primary
  //             storyline (no storyline → 未归属 chapter, single-lane mode).
  // 'drift'   — free-floating note, no storyline, no bookOrder.
  // The two are explicit: a chapter without a storyline is still a chapter
  // (kind='chapter', mainStorylineId=null), not auto-coerced to drift.
  kind: 'chapter' | 'drift';
  // Optional. Ignored when kind='drift'. null/undefined for kind='chapter'
  // means the new chapter goes 未归属.
  mainStorylineId?: string | null;
  // Optional / nullable. Drift nodes never have a bookOrder; chapter callers
  // should pass the computed next-bookOrder.
  bookOrder?: number | null;
  narrativeOrder?: number | null;
  title?: string;
  position?: BookNode['position'];
}

export interface UseBookNodeContext {
  projectId: string;
  userId: string;
}

export function useBookNode({ projectId, userId }: UseBookNodeContext) {
  const activeProjectId = projectId;
  if (!activeProjectId) {
    throw new Error('useBookNode requires a projectId');
  }
  if (!userId) {
    throw new Error('useBookNode requires a userId');
  }

  const nodeRepo = useMemo(
    () => createBookNodeSqliteRepository(activeProjectId),
    [activeProjectId],
  );
  const linkRepo = useMemo(
    () => createNodeStorylineLinkRepository(activeProjectId),
    [activeProjectId],
  );
  const contentRepoRef = useRef(createBookContentRepository());
  const contentRepo = contentRepoRef.current;
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const getNodesState = useCallback(() => useDataStore.getState().bookNodes, []);
  const setNodesState = useCallback(
    (nodes: BookNode[]) => useDataStore.getState().setBookNodes(nodes),
    [],
  );
  const addNodeToStorylineMappingState = useCallback(
    (storylineId: string, nodeId: string) =>
      useDataStore.getState().addNodeToStorylineMapping(storylineId, nodeId),
    [],
  );
  const updateNodeState = useCallback(
    (id: string, updates: Partial<BookNode>) => useDataStore.getState().updateBookNode(id, updates),
    [],
  );
  const loadNodes = useCallback(async () => {
    await ensureDb();
    log.debug('[loadBookNodes] Loading nodes from database');
    const nodes = await nodeRepo.findAll();
    log.debug(
      '[loadBookNodes] Loaded nodes count:',
      nodes.length,
      'ids:',
      nodes.map((n) => n.id),
    );
    const sorted = nodes.slice().sort(compareBookOrder);
    setNodesState(sorted);
    return sorted;
  }, [nodeRepo, ensureDb, setNodesState]);

  const createNode = useCallback(
    async (input: CreateNodeUsecaseInput) => {
      await ensureDb();
      const prevNodes = getNodesState().slice();

      if (!activeProjectId) {
        throw new Error('Project ID is required to create a node');
      }

      const now = new Date().toISOString();
      const baseFields = {
        id: uuidv7(),
        title: input.title ?? 'New Node',
        projectId: activeProjectId,
        narrativeOrder: input.narrativeOrder ?? null,
        summary: '',
        position: input.position ?? {
          // TODO: properly fit the graph node
          x: (Math.random() - 0.5) * 600,
          y: (Math.random() - 0.5) * 600,
        },
        wordCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      // Drift vs chapter is the explicit `kind` from the caller. A chapter
      // with no primary storyline is legal (未归属 / single-lane mode) — the
      // primary-storyline link goes into node_storyline_link when set.
      const primaryStorylineId = input.kind === 'drift' ? null : input.mainStorylineId ?? null;
      const newNode: BookNode =
        input.kind === 'drift'
          ? {
              ...baseFields,
              kind: 'drift',
              bookOrder: null,
              writingStatus: 'drifting',
            }
          : {
              ...baseFields,
              kind: 'chapter',
              bookOrder: input.bookOrder ?? 0,
              writingStatus: 'draft',
            };

      // Seed the new node's content from its primary storyline's
      // nodeContentTemplateJson when one is set; otherwise fall back to an
      // empty doc. Drift nodes (no primary storyline) skip the template lookup.
      const emptyDocJson = JSON.stringify({ type: 'doc', content: [] });
      const mainStoryline = primaryStorylineId
        ? useDataStore.getState().storylines.find((s) => s.id === primaryStorylineId)
        : null;
      const templateJson = mainStoryline?.nodeContentTemplateJson?.trim();
      const defaultDocJson =
        templateJson && templateJson !== '' && templateJson !== '{}'
          ? templateJson
          : emptyDocJson;

      const nextNodes = [...prevNodes, newNode].sort(compareBookOrder);

      return withOptimisticUpdate({
        apply: () => setNodesState(nextNodes),
        rollback: () => setNodesState(prevNodes),
        effect: async () => {
          return await getDb().transaction(async (tx) => {
            const nodeRepoTx = createBookNodeSqliteRepository(activeProjectId, tx);
            const linkRepoTx = createNodeStorylineLinkRepository(activeProjectId, tx);
            const contentRepoTx = createBookContentRepository(tx);
            const created = await nodeRepoTx.create(newNode);
            if (primaryStorylineId) {
              await linkRepoTx.addNodeToStoryline(created.id, primaryStorylineId, {
                isPrimary: true,
              });
            }
            await contentRepoTx.create({
              nodeId: created.id,
              contentJson: defaultDocJson,
            });
            return created;
          });
        },
        onSuccess: (created) => {
          const current = getNodesState();
          const merged = current
            .map((node) => (node.id === created.id ? created : node))
            .sort(compareBookOrder);
          setNodesState(merged);
          if (primaryStorylineId) {
            addNodeToStorylineMappingState(primaryStorylineId, created.id);
            useDataStore.getState().setNodePrimaryStoryline(created.id, primaryStorylineId);
          }
        },
        sync: (created) => {
          syncNodeCreate(created.id, activeProjectId, {
            id: created.id,
            title: created.title,
            summary: created.summary,
            bookOrder: created.bookOrder,
            narrativeOrder: created.narrativeOrder,
            // mainStorylineId is sent as a sync-time signal so the server
            // upserts the corresponding node_storyline_link.is_primary row
            // alongside the book_node insert. It is NOT a column on book_node.
            mainStorylineId: primaryStorylineId,
            kind: created.kind,
            positionX: created.position.x,
            positionY: created.position.y,
            writingStatus: created.writingStatus,
          });
          // Push the seeded content too so a fresh-from-template node shows
          // up filled-in on other devices before the user touches the editor.
          // Skip when the seed is the empty placeholder doc — that's the
          // pre-template behavior and the server's '{}' default already
          // matches it.
          if (defaultDocJson !== emptyDocJson) {
            syncNodeContentUpdate(created.id, activeProjectId, { contentJson: defaultDocJson });
          }
        },
      });
    },
    [
      nodeRepo,
      linkRepo,
      contentRepo,
      ensureDb,
      getNodesState,
      setNodesState,
      addNodeToStorylineMappingState,
      activeProjectId,
    ],
  );

  const renameNode = useCallback(
    async (id: string, title: string) => {
      await ensureDb();
      const prevNodes = getNodesState().slice();
      const existing = prevNodes.find((node) => node.id === id);
      if (!existing) throw new Error(`Book node ${id} not found`);

      const updatedAt = new Date().toISOString();
      return withOptimisticUpdate({
        apply: () => updateNodeState(id, { title, updatedAt }),
        rollback: () => setNodesState(prevNodes),
        effect: async () => {
          await nodeRepo.update(id, { title, updatedAt });
        },
        sync: () => syncNodeUpdate(id, activeProjectId, { title }),
      });
    },
    [nodeRepo, ensureDb, getNodesState, updateNodeState, setNodesState, activeProjectId],
  );

  const reorderNode = useCallback(
    async (id: string, direction: 'up' | 'down') => {
      await ensureDb();
      // Reorder only walks chapters — drift has no bookOrder axis to permute.
      const allNodes = getNodesState();
      const chapters = allNodes.filter(isChapter).slice().sort((a, b) => a.bookOrder - b.bookOrder);
      const index = chapters.findIndex((node) => node.id === id);
      if (index === -1) return;

      const swapIndex = direction === 'up' ? index - 1 : index + 1;
      if (swapIndex < 0 || swapIndex >= chapters.length) return;

      const current = chapters[index];
      const target = chapters[swapIndex];
      const currentOrder = current.bookOrder;
      const targetOrder = target.bookOrder;
      const now = new Date().toISOString();

      const nextNodes: BookNode[] = allNodes.map((node) => {
        if (node.id === current.id && isChapter(node)) {
          return { ...node, bookOrder: targetOrder, updatedAt: now };
        }
        if (node.id === target.id && isChapter(node)) {
          return { ...node, bookOrder: currentOrder, updatedAt: now };
        }
        return node;
      });

      const prev = allNodes.slice();

      return withOptimisticUpdate({
        apply: () => setNodesState(nextNodes),
        rollback: () => setNodesState(prev),
        effect: () =>
          nodeRepo.swapOrder(
            { id: current.id, bookOrder: currentOrder },
            { id: target.id, bookOrder: targetOrder },
          ),
        sync: () => {
          syncNodeUpdate(current.id, activeProjectId, { bookOrder: targetOrder });
          syncNodeUpdate(target.id, activeProjectId, { bookOrder: currentOrder });
        },
      });
    },
    [nodeRepo, ensureDb, getNodesState, setNodesState, activeProjectId],
  );

  const updateNodePosition = useCallback(
    async (id: string, position: BookNode['position']) => {
      if (!position) return;
      await ensureDb();
      const prevNodes = getNodesState().slice();
      const existing = prevNodes.find((node) => node.id === id);
      if (!existing) throw new Error(`Book node ${id} not found`);

      const updatedAt = new Date().toISOString();
      return withOptimisticUpdate({
        apply: () => updateNodeState(id, { position, updatedAt }),
        rollback: () => setNodesState(prevNodes),
        effect: async () => {
          await nodeRepo.update(id, { position, updatedAt });
        },
        sync: () =>
          syncNodeUpdate(id, activeProjectId, { positionX: position.x, positionY: position.y }),
      });
    },
    [nodeRepo, ensureDb, getNodesState, updateNodeState, setNodesState, activeProjectId],
  );

  const updateNodeSummary = useCallback(
    async (id: string, summary: string) => {
      await ensureDb();
      const prevNodes = getNodesState().slice();
      const existing = prevNodes.find((node) => node.id === id);
      if (!existing) throw new Error(`Book node ${id} not found`);

      const updatedAt = new Date().toISOString();
      return withOptimisticUpdate({
        apply: () => updateNodeState(id, { summary, updatedAt }),
        rollback: () => setNodesState(prevNodes),
        effect: async () => {
          await nodeRepo.update(id, { summary, updatedAt });
        },
        sync: () => syncNodeUpdate(id, activeProjectId, { summary }),
      });
    },
    [nodeRepo, ensureDb, getNodesState, updateNodeState, setNodesState, activeProjectId],
  );

  // `mainStorylineId` is accepted as an update SIGNAL — not a domain field on
  // BookNode (the column was retired). When set, it flips the primary storyline
  // link for this node; when null, it demotes whatever primary exists.
  const updateNode = useCallback(
    async (
      id: string,
      updates: Partial<BookNode> & { mainStorylineId?: string | null },
    ) => {
      await ensureDb();
      const prevNodes = getNodesState().slice();
      const existing = prevNodes.find((node) => node.id === id);
      if (!existing) throw new Error(`Book node ${id} not found`);

      const updatedAt = new Date().toISOString();
      const { mainStorylineId: newPrimary, ...nodeUpdates } = updates;
      const serverUpdates: Record<string, unknown> = { ...nodeUpdates };
      if (nodeUpdates.position) {
        serverUpdates.positionX = nodeUpdates.position.x;
        serverUpdates.positionY = nodeUpdates.position.y;
        delete serverUpdates.position;
      }

      const currentPrimary =
        useDataStore.getState().primaryStorylineByNode[id] ?? null;
      const mainChanged = newPrimary !== undefined && newPrimary !== currentPrimary;

      return withOptimisticUpdate({
        apply: () => {
          updateNodeState(id, { ...nodeUpdates, updatedAt });
          if (mainChanged) {
            useDataStore.getState().setNodePrimaryStoryline(id, newPrimary ?? null);
            if (newPrimary) addNodeToStorylineMappingState(newPrimary, id);
          }
        },
        rollback: () => setNodesState(prevNodes),
        effect: async () => {
          if (!mainChanged) {
            await nodeRepo.update(id, { ...nodeUpdates, updatedAt });
            return;
          }

          await getDb().transaction(async (tx) => {
            const nodeRepoTx = createBookNodeSqliteRepository(activeProjectId, tx);
            await nodeRepoTx.update(id, { ...nodeUpdates, updatedAt });
            // Flip the primary link atomically — demotes the previous primary
            // and promotes the new one (or just demotes when going to null).
            const linkRepoTx = createNodeStorylineLinkRepository(activeProjectId, tx);
            await linkRepoTx.setPrimaryStoryline(id, newPrimary ?? null);
          });
        },
        sync: () => {
          syncNodeUpdate(id, activeProjectId, serverUpdates);
          if (mainChanged && newPrimary) {
            syncNodeStorylineLinkCreate(id, newPrimary, activeProjectId, {
              isPrimary: true,
            });
          }
          // For demotion-without-replacement (newPrimary === null) the local
          // SQLite is updated, but the server outbox doesn't have a dedicated
          // "demote primary" path yet — Step 5 introduces the deletion-driven
          // semantics that supply this signal cleanly via the bulk PUT.
        },
      });
    },
    [
      ensureDb,
      getNodesState,
      updateNodeState,
      setNodesState,
      addNodeToStorylineMappingState,
      activeProjectId,
      nodeRepo,
    ],
  );

  const deleteNode = useCallback(
    async (id: string) => {
      await ensureDb();
      const prevNodes = getNodesState().slice();
      const existing = prevNodes.find((node) => node.id === id);
      if (!existing) throw new Error(`Book node ${id} not found`);

      const nextNodes = prevNodes.filter((node) => node.id !== id);
      useUiStore.getState().closeTabsForEntity(activeProjectId, { entityType: 'node', id });

      // Paywall: Pro/Studio users send the entity to the trash (soft-delete);
      // Free users get the historical hard-DELETE behavior. The server-side
      // free-tier-cleanup job catches anyone who churns from paid → free.
      if (canUseFeature('trash')) {
        return withOptimisticUpdate({
          // Mark trashed so open editors dim (not strip) inline mentions to
          // this chapter — soft-deleted is recoverable, unlike a hard delete.
          apply: () => {
            setNodesState(nextNodes);
            useDataStore.getState().markTrashed('node', id);
          },
          rollback: () => {
            setNodesState(prevNodes);
            useDataStore.getState().unmarkTrashed('node', id);
          },
          effect: () => nodeRepo.softDelete(id),
          sync: () => syncNodeSoftDelete(id, activeProjectId),
        });
      }

      return withOptimisticUpdate({
        apply: () => setNodesState(nextNodes),
        rollback: () => setNodesState(prevNodes),
        effect: () => nodeRepo.delete(id),
        sync: () => syncNodeDelete(id, activeProjectId),
      });
    },
    [nodeRepo, ensureDb, getNodesState, setNodesState, activeProjectId],
  );

  const restoreNode = useCallback(
    async (id: string) => {
      await ensureDb();
      await nodeRepo.restore(id);
      syncNodeRestore(id, activeProjectId);
      useDataStore.getState().unmarkTrashed('node', id);
      const fresh = await nodeRepo.findAll();
      setNodesState(fresh);
    },
    [nodeRepo, ensureDb, setNodesState, activeProjectId],
  );

  // Permanently delete an already-trashed node — the "立刻删除" path in the
  // trash UI. node_content and storyline links cascade off the FK; the node is
  // not in the active store (soft-deleted) so nothing to mutate there.
  const purgeNode = useCallback(
    async (id: string) => {
      await ensureDb();
      await nodeRepo.delete(id);
      syncNodeDelete(id, activeProjectId);
      // No longer trashed — it's gone for good. Mentions flip dim → stripped.
      useDataStore.getState().unmarkTrashed('node', id);
    },
    [nodeRepo, ensureDb, activeProjectId],
  );

  const listTrashedNodes = useCallback(async () => {
    await ensureDb();
    return await nodeRepo.findTrashed();
  }, [nodeRepo, ensureDb]);

  return useMemo(
    () => ({
      loadNodes,
      createNode,
      renameNode,
      reorderNode,
      updateNodePosition,
      updateNodeSummary,
      updateNode,
      deleteNode,
      restoreNode,
      purgeNode,
      listTrashedNodes,
    }),
    [
      loadNodes,
      createNode,
      renameNode,
      reorderNode,
      updateNodePosition,
      updateNodeSummary,
      updateNode,
      deleteNode,
      restoreNode,
      purgeNode,
      listTrashedNodes,
    ],
  );
}
