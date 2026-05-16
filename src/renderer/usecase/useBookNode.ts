import { useCallback, useMemo, useRef } from 'react';
import { useDataStore } from '../store/data-store';
import {
  createBookNodeSqliteRepository,
  createBookNodeEdgeSqliteRepository,
} from '../sqlite-repo/node-repo.ts';
import { createBookContentRepository } from '../sqlite-repo/content-repo.ts';
import { createNodeStorylineLinkRepository } from '../sqlite-repo/node-storyline-link-repo.ts';
import type { BookNode, BookNodeEdge } from '../domain/book-node.ts';
import { initDatabase } from '../lib/db';
import { v7 as uuidv7 } from 'uuid';
import loglevel from 'loglevel';
import { withOptimisticUpdate } from './optimistic';
import {
  syncNodeCreate,
  syncNodeUpdate,
  syncNodeDelete,
  syncEdgeCreate,
  syncEdgeUpdate,
  syncEdgeDelete,
} from './sync-helpers';

const log = loglevel.getLogger('UseBookNode');
log.setLevel(loglevel.levels.ERROR);

export interface CreateNodeUsecaseInput {
  storyStageId?: string;
  mainStorylineId: string;
  start: number;
  end?: number;
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
  const edgeRepo = useMemo(
    () => createBookNodeEdgeSqliteRepository(activeProjectId),
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
  const setEdgesState = useCallback(
    (edges: BookNodeEdge[]) => useDataStore.getState().setNodeEdges(edges),
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
    const sorted = nodes.slice().sort((a, b) => a.start - b.start);
    setNodesState(sorted);
    return sorted;
  }, [nodeRepo, ensureDb, setNodesState]);

  const loadEdges = useCallback(async () => {
    await ensureDb();
    const edges = await edgeRepo.findAll();
    setEdgesState(edges);
    return edges;
  }, [edgeRepo, ensureDb, setEdgesState]);

  const createNode = useCallback(
    async (input: CreateNodeUsecaseInput) => {
      await ensureDb();
      const prevNodes = getNodesState().slice();

      if (!activeProjectId) {
        throw new Error('Project ID is required to create a node');
      }

      if (!input.mainStorylineId) {
        throw new Error('Main storyline is required to create a node');
      }

      const now = new Date().toISOString();
      const newNode: BookNode = {
        id: uuidv7(),
        title: input.title ?? 'New Node',
        projectId: activeProjectId,
        start: input.start,
        end: input.end ?? input.start,
        summary: '',
        storyStageId: input.storyStageId ?? null,
        mainStorylineId: input.mainStorylineId,
        position: input.position ?? {
          // TODO: properly fit the graph node
          x: (Math.random() - 0.5) * 600,
          y: (Math.random() - 0.5) * 600,
        },
        createdAt: now,
        updatedAt: now,
      };

      // Create default empty content for the new node
      const defaultDocJson = JSON.stringify({
        type: 'doc',
        content: [],
      });

      const nextNodes = [...prevNodes, newNode].sort((a, b) => a.start - b.start);

      return withOptimisticUpdate({
        apply: () => setNodesState(nextNodes),
        rollback: () => setNodesState(prevNodes),
        effect: async () => {
          const created = await nodeRepo.create(newNode);
          try {
            await linkRepo.addNodeToStoryline(created.id, created.mainStorylineId);
          } catch (error) {
            await nodeRepo.delete(created.id);
            throw error;
          }
          try {
            await contentRepo.create({
              nodeId: created.id,
              contentJson: defaultDocJson,
            });
            log.debug('Created default content for new node:', created.id);
          } catch (error) {
            log.error('Failed to create default content for new node:', error);
          }
          return created;
        },
        onSuccess: (created) => {
          const current = getNodesState();
          const merged = current
            .map((node) => (node.id === created.id ? created : node))
            .sort((a, b) => a.start - b.start);
          setNodesState(merged);
          addNodeToStorylineMappingState(created.mainStorylineId, created.id);
        },
        sync: (created) =>
          syncNodeCreate(created.id, activeProjectId, {
            id: created.id,
            title: created.title,
            summary: created.summary,
            start: created.start,
            end: created.end,
            storyStageId: created.storyStageId,
            mainStorylineId: created.mainStorylineId,
            positionX: created.position.x,
            positionY: created.position.y,
          }),
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
      const nodes = getNodesState()
        .slice()
        .sort((a, b) => a.start - b.start);
      const index = nodes.findIndex((node) => node.id === id);
      if (index === -1) return;

      const swapIndex = direction === 'up' ? index - 1 : index + 1;
      if (swapIndex < 0 || swapIndex >= nodes.length) return;

      const current = nodes[index];
      const target = nodes[swapIndex];
      const currentStart = current.start;
      const targetStart = target.start;
      const now = new Date().toISOString();

      const nextNodes = nodes
        .map((node) => {
          if (node.id === current.id) {
            return { ...node, start: targetStart, updatedAt: now };
          }
          if (node.id === target.id) {
            return { ...node, start: currentStart, updatedAt: now };
          }
          return node;
        })
        .sort((a, b) => a.start - b.start);

      const prev = getNodesState().slice();

      return withOptimisticUpdate({
        apply: () => setNodesState(nextNodes),
        rollback: () => setNodesState(prev),
        effect: () =>
          nodeRepo.swapOrder(
            { id: current.id, start: currentStart },
            { id: target.id, start: targetStart },
          ),
        sync: () => {
          syncNodeUpdate(current.id, activeProjectId, { start: targetStart });
          syncNodeUpdate(target.id, activeProjectId, { start: currentStart });
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
      return withOptimisticUpdate({
        apply: () => updateNodeState(id, { ...updates, updatedAt }),
        rollback: () => setNodesState(prevNodes),
        effect: async () => {
          await nodeRepo.update(id, { ...updates, updatedAt });
        },
        sync: () => syncNodeUpdate(id, activeProjectId, serverUpdates),
      });
    },
    [nodeRepo, ensureDb, getNodesState, updateNodeState, setNodesState, activeProjectId],
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

  const updateEdge = useCallback(
    async (id: string, updates: Partial<BookNodeEdge>) => {
      await ensureDb();
      const result = await edgeRepo.update(id, { ...updates, updatedAt: new Date().toISOString() });
      syncEdgeUpdate(id, activeProjectId, updates);
      return result;
    },
    [edgeRepo, ensureDb, activeProjectId],
  );

  const createEdge = useCallback(
    async (input: BookNodeEdge) => {
      await ensureDb();
      const prevEdges = useDataStore.getState().nodeEdges.slice();
      const optimistic = [...prevEdges, input];

      return withOptimisticUpdate({
        apply: () => setEdgesState(optimistic),
        rollback: () => setEdgesState(prevEdges),
        effect: async () => edgeRepo.create(input),
        onSuccess: (created) => {
          const current = useDataStore.getState().nodeEdges;
          setEdgesState(current.map((edge) => (edge.id === created.id ? created : edge)));
        },
        sync: (created) =>
          syncEdgeCreate(created.id, activeProjectId, {
            id: created.id,
            sourceNodeId: created.sourceNodeId,
            targetNodeId: created.targetNodeId,
            label: created.label,
            weight: created.weight,
            isDirected: created.isDirected,
          }),
      });
    },
    [edgeRepo, ensureDb, setEdgesState, activeProjectId],
  );

  const deleteEdge = useCallback(
    async (id: string) => {
      await ensureDb();
      const prevEdges = useDataStore.getState().nodeEdges.slice();
      const nextEdges = prevEdges.filter((edge) => edge.id !== id);

      return withOptimisticUpdate({
        apply: () => setEdgesState(nextEdges),
        rollback: () => setEdgesState(prevEdges),
        effect: async () => {
          await edgeRepo.delete(id);
        },
        sync: () => syncEdgeDelete(id, activeProjectId),
      });
    },
    [edgeRepo, ensureDb, setEdgesState, activeProjectId],
  );

  return useMemo(
    () => ({
      loadNodes,
      loadEdges,
      createNode,
      renameNode,
      reorderNode,
      updateNodePosition,
      updateNodeSummary,
      updateNode,
      deleteNode,
      updateEdge,
      createEdge,
      deleteEdge,
    }),
    [
      loadNodes,
      loadEdges,
      createNode,
      renameNode,
      reorderNode,
      updateNodePosition,
      updateNodeSummary,
      updateNode,
      deleteNode,
      updateEdge,
      createEdge,
      deleteEdge,
    ],
  );
}
