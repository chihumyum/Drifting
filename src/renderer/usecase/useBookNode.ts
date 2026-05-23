import { useCallback, useMemo, useRef } from 'react';
import { useDataStore } from '../store/data-store';
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
  syncNodeStorylineLinkCreate,
  syncNodeContentUpdate,
} from './sync-helpers';

const log = loglevel.getLogger('UseBookNode');
log.setLevel(loglevel.levels.ERROR);

export interface CreateNodeUsecaseInput {
  // null = drift node (no storyline membership)
  mainStorylineId: string | null;
  // Optional / nullable: drift nodes (mainStorylineId == null) have no
  // place on the reading axis. Callers creating a chapter should pass the
  // computed bookOrder; drift callers should omit it or pass null.
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
      // Drift vs chapter is the discriminator — build the correct variant
      // so the domain invariant `drift => bookOrder == null` is enforced at
      // the source and TypeScript can narrow downstream.
      const newNode: BookNode =
        input.mainStorylineId == null
          ? {
              ...baseFields,
              mainStorylineId: null,
              bookOrder: null,
              writingStatus: 'drifting',
            }
          : {
              ...baseFields,
              mainStorylineId: input.mainStorylineId,
              bookOrder: input.bookOrder ?? 0,
              writingStatus: 'draft',
            };

      // Seed the new node's content from its main storyline's
      // nodeContentTemplateJson when one is set; otherwise fall back to an
      // empty doc. Drift nodes (no main storyline) skip the template lookup.
      const emptyDocJson = JSON.stringify({ type: 'doc', content: [] });
      const mainStoryline = newNode.mainStorylineId
        ? useDataStore.getState().storylines.find((s) => s.id === newNode.mainStorylineId)
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
            if (created.mainStorylineId) {
              await linkRepoTx.addNodeToStoryline(created.id, created.mainStorylineId);
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
          if (created.mainStorylineId) {
            addNodeToStorylineMappingState(created.mainStorylineId, created.id);
          }
        },
        sync: (created) => {
          syncNodeCreate(created.id, activeProjectId, {
            id: created.id,
            title: created.title,
            summary: created.summary,
            bookOrder: created.bookOrder,
            narrativeOrder: created.narrativeOrder,
            mainStorylineId: created.mainStorylineId,
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

  const updateNode = useCallback(
    async (id: string, updates: Partial<BookNode>) => {
      await ensureDb();
      const prevNodes = getNodesState().slice();
      const existing = prevNodes.find((node) => node.id === id);
      if (!existing) throw new Error(`Book node ${id} not found`);

      const updatedAt = new Date().toISOString();
      const serverUpdates: Record<string, unknown> = { ...updates };
      if (updates.position) {
        serverUpdates.positionX = updates.position.x;
        serverUpdates.positionY = updates.position.y;
        delete serverUpdates.position;
      }

      const mainChanged =
        updates.mainStorylineId !== undefined && updates.mainStorylineId !== existing.mainStorylineId;

      return withOptimisticUpdate({
        apply: () => {
          updateNodeState(id, { ...updates, updatedAt });
          if (mainChanged && updates.mainStorylineId) {
            addNodeToStorylineMappingState(updates.mainStorylineId, id);
          }
        },
        rollback: () => setNodesState(prevNodes),
        effect: async () => {
          if (!mainChanged) {
            await nodeRepo.update(id, { ...updates, updatedAt });
            return;
          }

          await getDb().transaction(async (tx) => {
            const nodeRepoTx = createBookNodeSqliteRepository(activeProjectId, tx);
            await nodeRepoTx.update(id, { ...updates, updatedAt });
            if (updates.mainStorylineId) {
              const linkRepoTx = createNodeStorylineLinkRepository(activeProjectId, tx);
              await linkRepoTx.addNodeToStoryline(id, updates.mainStorylineId);
            }
          });
        },
        sync: () => {
          syncNodeUpdate(id, activeProjectId, serverUpdates);
          if (mainChanged && updates.mainStorylineId) {
            syncNodeStorylineLinkCreate(id, updates.mainStorylineId, activeProjectId);
          }
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
      log.debug('[deleteBookNode] Starting delete for node:', id);
      const prevNodes = getNodesState().slice();
      const existing = prevNodes.find((node) => node.id === id);
      if (!existing) throw new Error(`Book node ${id} not found`);

      log.debug('[deleteBookNode] Node found, removing from state optimistically');
      const nextNodes = prevNodes.filter((node) => node.id !== id);
      return withOptimisticUpdate({
        apply: () => setNodesState(nextNodes),
        rollback: () => setNodesState(prevNodes),
        effect: async () => {
          log.debug('[deleteBookNode] Calling repository delete');
          await nodeRepo.delete(id);
          log.debug('[deleteBookNode] Repository delete successful');
        },
        sync: () => syncNodeDelete(id, activeProjectId),
      });
    },
    [nodeRepo, ensureDb, getNodesState, setNodesState, activeProjectId],
  );

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
    ],
  );
}
