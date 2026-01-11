import { useCallback, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useDataStore } from '../store/data-store';
import { createBookNodeSqliteRepository, createBookNodeEdgeSqliteRepository } from '../repositories/node-repo.ts';
import { createBookContentRepository } from '../repositories/content-repo.ts';
import type { BookNode, BookNodeEdge } from '../domain/book-node';
import { initDatabase } from '../lib/db';
import { useAuthStore, getProjectId } from '../store/auth';
import loglevel from "loglevel";

const log = loglevel.getLogger("UseBookNode");
log.setLevel(loglevel.levels.ERROR);

export interface CreateBookNodeInput {
  title: string;
  projectId: string;
  storyStageId: string;
  storylineIds: string[];
  summary: string;
  start: number;
  end: number;
  position: BookNode['position'];
}

const getProjectIdForUser = () => {
  const user = useAuthStore.getState().user;
  return getProjectId(user?.id);
};

export function useBookNode() {
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();

  // Use route projectId if available, otherwise fallback to user default (legacy)
  const activeProjectId = routeProjectId ?? getProjectIdForUser();

  const nodeRepo = useMemo(() => createBookNodeSqliteRepository(activeProjectId), [activeProjectId]);
  const edgeRepo = useMemo(() => createBookNodeEdgeSqliteRepository(activeProjectId), [activeProjectId]);
  const contentRepoRef = useRef(createBookContentRepository());
  const contentRepo = contentRepoRef.current;

  const ensureDb = useCallback((projectId?: string) =>
    initDatabase(projectId ?? activeProjectId),
    [activeProjectId]);

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
    const nodes = getNodesState();

    const targetProjectId = input.projectId ?? activeProjectId ?? getProjectIdForUser();
    if (!targetProjectId) {
      log.error('[createNode] No projectId available for creation. input:', input, 'active:', activeProjectId);
      throw new Error('Project ID is required to create a node');
    }

    const created = await nodeRepo.create({
      title: input.title,
      projectId: targetProjectId,
      start: input.start,
      end: input.end,
      summary: input.summary,
      storyStageId: input.storyStageId,
      storylineIds: input.storylineIds,
      tagIds: [], // create a new node comes with no tags by default
      position: input.position ?? {
        x: (Math.random() - 0.5) * 600,
        y: (Math.random() - 0.5) * 600,
      },
    });

    // Create default empty content for the new node
    const defaultDocJson = JSON.stringify({
      type: 'doc',
      content: [],
    });

    try {
      await contentRepo.create({
        nodeId: created.id,
        projectId: created.projectId,
        contentJson: defaultDocJson,
      });
      log.debug('Created default content for new node:', created.id);
    } catch (error) {
      log.error('Failed to create default content for new node:', error);
    }

    const nextNodes = [...nodes, created].sort((a, b) => a.start - b.start);
    setNodesState(nextNodes);
    return created;
  }, [nodeRepo, contentRepo, ensureDb, getNodesState, setNodesState]);

  const renameNode = useCallback(async (id: string, title: string) => {
    await ensureDb();
    const prevNodes = getNodesState().slice();
    const existing = prevNodes.find((node) => node.id === id);
    if (!existing) throw new Error(`Book node ${id} not found`);

    updateNodeState(id, { title });

    try {
      await nodeRepo.update(id, { title });
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
    } catch (error) {
      setNodesState(prev);
      throw error;
    }
  }, [nodeRepo, ensureDb, getNodesState, setNodesState]);

  const updateNodePosition = useCallback(async (id: string, position: BookNode['position']) => {
    if (!position) return;
    await ensureDb();
    const prevNodes = getNodesState();
    const existing = prevNodes.find((node) => node.id === id);
    if (!existing) throw new Error(`Book node ${id} not found`);

    updateNodeState(id, { position });

    try {
      await nodeRepo.update(id, { position });
    } catch (error) {
      setNodesState(prevNodes);
      throw error;
    }
  }, [nodeRepo, ensureDb, getNodesState, updateNodeState, setNodesState]);

  const updateNodeSummary = useCallback(async (id: string, summary: string) => {
    await ensureDb();
    const prevNodes = getNodesState().slice();
    const existing = prevNodes.find((node) => node.id === id);
    if (!existing) throw new Error(`Book node ${id} not found`);

    updateNodeState(id, { summary: summary });

    try {
      await nodeRepo.update(id, { summary: summary });
    } catch (error) {
      setNodesState(prevNodes);
      throw error;
    }
  }, [nodeRepo, ensureDb, getNodesState, updateNodeState, setNodesState]);

  const updateNode = useCallback(async (id: string, updates: Partial<BookNode>) => {
    await ensureDb();
    const prevNodes = getNodesState().slice();
    const existing = prevNodes.find((node) => node.id === id);
    if (!existing) throw new Error(`Book node ${id} not found`);

    updateNodeState(id, updates);

    try {
      await nodeRepo.update(id, updates);
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
    } catch (error) {
      log.error('[deleteBookNode] Repository delete failed, rolling back:', error);
      setNodesState(prevNodes);
      throw error;
    }
  }, [nodeRepo, ensureDb, getNodesState, setNodesState]);

  const updateEdge = useCallback(async (id: string, updates: Partial<BookNodeEdge>) => {
    await ensureDb();
    return await edgeRepo.update(id, updates);
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
