import { useCallback, useMemo, useRef } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import { createBookNodeSqliteRepository, createBookNodeEdgeSqliteRepository } from '../repositories/book_node_sqlite';
import { createBookContentRepository } from '../repositories/book_content_sqlite';
import type { BookNode, BookNodeEdge } from '../domain/book-node';
import { initDatabase } from '../lib/db';
import { useAuthStore, getProjectId } from '../store/auth';
import { syncManager } from '../lib/sync/sync-manager';
import type { SyncTaskType } from '../lib/sync/types';
import loglevel from "loglevel";

const log = loglevel.getLogger("UseBookNode");
log.setLevel(loglevel.levels.ERROR);

export interface CreateBookNodeInput {
  title: string;
  projectId?: string;
  summary?: string | null;
  storyStageId?: string | null;
  start?: number;
  end?: number | null;
  position?: BookNode['position'];
}

const getProjectIdForUser = () => {
  const user = useAuthStore.getState().user;
  return getProjectId(user?.id);
};

const canSync = () => {
  const { isAuthenticated } = useAuthStore.getState();
  return isAuthenticated;
};

const enqueueNodeTask = (
  type: SyncTaskType,
  node: Pick<BookNode, 'id' | 'projectId'>,
  data?: Partial<BookNode>
) => {
  if (!canSync()) return;
  syncManager.enqueue({
    type,
    entity: 'node',
    localId: node.id,
    projectId: node.projectId,
    data,
    priority: 'normal',
  });
};

export function useBookNode() {
  const nodeRepoRef = useRef(createBookNodeSqliteRepository(getProjectIdForUser()));
  const edgeRepoRef = useRef(createBookNodeEdgeSqliteRepository(getProjectIdForUser()));
  const contentRepoRef = useRef(createBookContentRepository());
  
  const nodeRepo = nodeRepoRef.current;
  const edgeRepo = edgeRepoRef.current;
  const contentRepo = contentRepoRef.current;

  const ensureDb = useCallback((projectId?: string) => 
    initDatabase(projectId ?? getProjectIdForUser()), 
  []);
  
  const getNodesState = useCallback(() => useDataStore.getState().bookNodes, []);
  const setNodesState = useCallback((nodes: BookNode[]) => useDataStore.getState().setBookNodes(nodes), []);
  const updateNodeState = useCallback((id: string, updates: Partial<BookNode>) => 
    useDataStore.getState().updateBookNode(id, updates), 
  []);
  const setEdgesState = useCallback((edges: BookNodeEdge[]) => useDataStore.getState().setNodeEdges(edges), []);

  const loadNodes = useCallback(async (options?: { projectId?: string }) => {
    await ensureDb(options?.projectId);
    log.debug('[loadBookNodes] Loading nodes from database, projectId:', options?.projectId);
    const nodes = await nodeRepo.findAll(options?.projectId);
    log.debug('[loadBookNodes] Loaded nodes count:', nodes.length, 'ids:', nodes.map(n => n.id));
    const sorted = nodes.slice().sort((a, b) => a.start - b.start);
    setNodesState(sorted);
    return sorted;
  }, [nodeRepo, ensureDb, setNodesState]);

  const loadEdges = useCallback(async (projectId?: string) => {
    await ensureDb(projectId);
    const edges = await edgeRepo.findAll(projectId);
    setEdgesState(edges);
    return edges;
  }, [edgeRepo, ensureDb, setEdgesState]);

  const createNode = useCallback(async (input: CreateBookNodeInput) => {
    await ensureDb(input.projectId);
    const now = new Date();
    const nodes = getNodesState();
    const maxStart = nodes.reduce((max, node) => Math.max(max, node.start), Number.NEGATIVE_INFINITY);
    const nextStart = Number.isFinite(maxStart) ? maxStart + 1 : 1;

    const created = await nodeRepo.create({
      title: input.title,
      projectId: input.projectId,
      start: input.start ?? nextStart,
      end: input.end ?? null,
      summary: input.summary ?? null,
      storyStageId: input.storyStageId ?? null,
      position: input.position ?? {
        x: (Math.random() - 0.5) * 600,
        y: (Math.random() - 0.5) * 600,
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    // Create default empty content for the new node
    const defaultDocJson = JSON.stringify({
      type: 'doc',
      content: [],
    });

    try {
      await contentRepo.create({
        id: uuidv7(),
        nodeId: created.id,
        projectId: created.projectId,
        pmJson: defaultDocJson,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      log.debug('Created default content for new node:', created.id);
    } catch (error) {
      log.error('Failed to create default content for new node:', error);
    }

    const nextNodes = [...nodes, created].sort((a, b) => a.start - b.start);
    setNodesState(nextNodes);
    enqueueNodeTask('create', created, created);
    return created;
  }, [nodeRepo, contentRepo, ensureDb, getNodesState, setNodesState]);

  const renameNode = useCallback(async (id: string, title: string) => {
    await ensureDb();
    const now = new Date().toISOString();
    const prevNodes = getNodesState().slice();
    const existing = prevNodes.find((node) => node.id === id);
    if (!existing) throw new Error(`Book node ${id} not found`);

    updateNodeState(id, { title, updatedAt: now });

    try {
      await nodeRepo.update(id, { title, updatedAt: now });
      enqueueNodeTask('update', existing, { title, updatedAt: now });
    } catch (error) {
      setNodesState(prevNodes);
      throw error;
    }
  }, [nodeRepo, ensureDb, getNodesState, updateNodeState, setNodesState]);

  const reorderNode = useCallback(async (id: string, direction: 'up' | 'down') => {
    await ensureDb();
    const nodes = getNodesState().slice().sort((a, b) => a.start - b.start);
    const index = nodes.findIndex((node) => node.id === id);
    if (index === -1) return;

    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= nodes.length) return;

    const current = nodes[index];
    const target = nodes[swapIndex];
    const currentStart = current.start;
    const targetStart = target.start;
    const now = new Date().toISOString();

    const nextNodes = nodes.map((node) => {
      if (node.id === current.id) {
        return { ...node, start: targetStart, updatedAt: now };
      }
      if (node.id === target.id) {
        return { ...node, start: currentStart, updatedAt: now };
      }
      return node;
    }).sort((a, b) => a.start - b.start);

    const prev = getNodesState().slice();
    setNodesState(nextNodes);

    try {
      await nodeRepo.swapOrder({ id: current.id, start: currentStart }, { id: target.id, start: targetStart });
      enqueueNodeTask('update', current, { start: targetStart, updatedAt: now });
      enqueueNodeTask('update', target, { start: currentStart, updatedAt: now });
    } catch (error) {
      setNodesState(prev);
      throw error;
    }
  }, [nodeRepo, ensureDb, getNodesState, setNodesState]);

  const updateNodePosition = useCallback(async (id: string, position: BookNode['position']) => {
    if (!position) return;
    await ensureDb();
    const now = new Date().toISOString();
    const prevNodes = getNodesState();
    const existing = prevNodes.find((node) => node.id === id);
    if (!existing) throw new Error(`Book node ${id} not found`);

    updateNodeState(id, { position, updatedAt: now });

    try {
      await nodeRepo.update(id, { position, updatedAt: now });
      enqueueNodeTask('update', existing, { position, updatedAt: now });
    } catch (error) {
      setNodesState(prevNodes);
      throw error;
    }
  }, [nodeRepo, ensureDb, getNodesState, updateNodeState, setNodesState]);

  const updateNodeSummary = useCallback(async (id: string, summary: string | null) => {
    await ensureDb();
    const now = new Date().toISOString();
    const prevNodes = getNodesState().slice();
    const existing = prevNodes.find((node) => node.id === id);
    if (!existing) throw new Error(`Book node ${id} not found`);

    updateNodeState(id, { summary, updatedAt: now });

    try {
      await nodeRepo.update(id, { summary, updatedAt: now });
      enqueueNodeTask('update', existing, { summary: summary ?? '', updatedAt: now });
    } catch (error) {
      setNodesState(prevNodes);
      throw error;
    }
  }, [nodeRepo, ensureDb, getNodesState, updateNodeState, setNodesState]);

  const updateNode = useCallback(async (id: string, updates: Partial<BookNode>) => {
    await ensureDb();
    const now = new Date().toISOString();
    const prevNodes = getNodesState().slice();
    const existing = prevNodes.find((node) => node.id === id);
    if (!existing) throw new Error(`Book node ${id} not found`);

    const updatesWithTimestamp = { ...updates, updatedAt: now };
    updateNodeState(id, updatesWithTimestamp);

    try {
      await nodeRepo.update(id, updatesWithTimestamp);
      enqueueNodeTask('update', existing, updatesWithTimestamp);
    } catch (error) {
      setNodesState(prevNodes);
      throw error;
    }
  }, [nodeRepo, ensureDb, getNodesState, updateNodeState, setNodesState]);

  const deleteNode = useCallback(async (id: string) => {
    await ensureDb();
    log.debug('[deleteBookNode] Starting delete for node:', id);
    const prevNodes = getNodesState().slice();
    const existing = prevNodes.find((node) => node.id === id);
    if (!existing) throw new Error(`Book node ${id} not found`);

    log.debug('[deleteBookNode] Node found, removing from state optimistically');
    const nextNodes = prevNodes.filter((node) => node.id !== id);
    setNodesState(nextNodes);

    try {
      log.debug('[deleteBookNode] Calling repository delete');
      await nodeRepo.delete(id);
      log.debug('[deleteBookNode] Repository delete successful');
      enqueueNodeTask('delete', existing);
    } catch (error) {
      log.error('[deleteBookNode] Repository delete failed, rolling back:', error);
      setNodesState(prevNodes);
      throw error;
    }
  }, [nodeRepo, ensureDb, getNodesState, setNodesState]);

  const updateEdge = useCallback(async (id: string, updates: Partial<BookNodeEdge>) => {
    await ensureDb();
    const now = new Date().toISOString();
    return await edgeRepo.update(id, { ...updates, updatedAt: now });
  }, [edgeRepo, ensureDb]);

  return useMemo(() => ({
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
  }), [
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
  ]);
}
