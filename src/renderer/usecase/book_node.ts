// operations related to book nodes & node edges
import type { BookNode, BookNodeEdge } from '../domain/book_node';
import type { BookNodeEdgeRepository, BookNodeRepository } from '../repositories/book_node';
import type { BookContentRepository } from '../repositories/book_content';
import type { StorylineRepository } from '../repositories/storyline';
import { v7 as uuidv7 } from 'uuid';
import { syncManager } from '../lib/sync/sync-manager';
import { useAuthStore } from '../store/auth';
import type { SyncTaskType } from '../lib/sync/types';
import log from "loglevel";

log.setLevel(log.levels.ERROR);

export {
  loadBookNodes,
  loadBookNodeEdges,
  createBookNode,
  renameBookNode,
  reorderBookNode,
  updateBookNodePosition,
  updateBookNodeSummary,
  updateBookNode,
  deleteBookNode,
};

export interface BookNodeUsecaseDeps {
  nodeRepo: BookNodeRepository;
  edgeRepo: BookNodeEdgeRepository;
  storylineRepo: StorylineRepository;
  contentRepo: BookContentRepository;
  // state related
  getNodesState: () => BookNode[];
  setNodesState: (nodes: BookNode[]) => void;
  updateNodeState: (id: string, updates: Partial<BookNode>) => void;
  setEdgesState: (edges: BookNodeEdge[]) => void;
  now?: () => Date;
}

function getNow(deps: BookNodeUsecaseDeps) {
  return (deps.now ?? (() => new Date()))();
}

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

async function loadBookNodes(deps: BookNodeUsecaseDeps, options?: { projectId?: string }) {
  log.debug('[loadBookNodes] Loading nodes from database, projectId:', options?.projectId);
  const nodes = await deps.nodeRepo.findAll(options?.projectId);
  log.debug('[loadBookNodes] Loaded nodes count:', nodes.length, 'ids:', nodes.map(n => n.id));
  const sorted = nodes.slice().sort((a, b) => a.start - b.start);
  deps.setNodesState(sorted);
  return sorted;
}

async function loadBookNodeEdges(deps: BookNodeUsecaseDeps, projectId?: string) {
  const edges = await deps.edgeRepo.findAll(projectId);
  deps.setEdgesState(edges);
  return edges;
}

export interface CreateBookNodeInput {
  title: string;
  projectId?: string;
  summary?: string | null;
  storyStageId?: string | null;
  start?: number;
  end?: number | null;
  position?: BookNode['position'];
}

async function createBookNode(deps: BookNodeUsecaseDeps, input: CreateBookNodeInput) {
  const now = getNow(deps);
  const nodes = deps.getNodesState();
  const maxStart = nodes.reduce((max, node) => Math.max(max, node.start), Number.NEGATIVE_INFINITY);
  const nextStart = Number.isFinite(maxStart) ? maxStart + 1 : 1;

  const created = await deps.nodeRepo.create({
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
    await deps.contentRepo.create({
      id: uuidv7(),
      nodeId: created.id,
      pmJson: defaultDocJson,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    log.debug('Created default content for new node:', created.id);
  } catch (error) {
    log.error('Failed to create default content for new node:', error);
    // Don't fail the node creation if content creation fails
  }

  // Note: Do not automatically assign any storyline to the node
  // The caller should explicitly add the node to the desired storyline
  // This allows flexibility in choosing which storyline the node belongs to

  const node = created;
  const nextNodes = [...nodes, node].sort((a, b) => a.start - b.start);
  deps.setNodesState(nextNodes);
  enqueueNodeTask('create', node, node);
  return node;
}

async function renameBookNode(deps: BookNodeUsecaseDeps, id: string, title: string) {
  const now = getNow(deps).toISOString();
  const prevNodes = deps.getNodesState().slice();
  const existing = prevNodes.find((node) => node.id === id);
  if (!existing) throw new Error(`Book node ${id} not found`);

  deps.updateNodeState(id, { title, updatedAt: now });

  try {
    await deps.nodeRepo.update(id, { title, updatedAt: now });
    enqueueNodeTask('update', existing, { title, updatedAt: now });
  } catch (error) {
    deps.setNodesState(prevNodes);
    throw error;
  }
}

async function reorderBookNode(deps: BookNodeUsecaseDeps, id: string, direction: 'up' | 'down') {
  const nodes = deps.getNodesState().slice().sort((a, b) => a.start - b.start);
  const index = nodes.findIndex((node) => node.id === id);
  if (index === -1) return;

  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= nodes.length) return;

  const current = nodes[index];
  const target = nodes[swapIndex];
  const currentStart = current.start;
  const targetStart = target.start;
  const now = getNow(deps).toISOString();

  const nextNodes = nodes.map((node) => {
    if (node.id === current.id) {
      return { ...node, start: targetStart, updatedAt: now };
    }
    if (node.id === target.id) {
      return { ...node, start: currentStart, updatedAt: now };
    }
    return node;
  }).sort((a, b) => a.start - b.start);

  const prev = deps.getNodesState().slice();
  deps.setNodesState(nextNodes);

  try {
    await deps.nodeRepo.swapOrder({ id: current.id, start: currentStart }, { id: target.id, start: targetStart });
    enqueueNodeTask('update', current, { start: targetStart, updatedAt: now });
    enqueueNodeTask('update', target, { start: currentStart, updatedAt: now });
  } catch (error) {
    deps.setNodesState(prev);
    throw error;
  }
}

async function updateBookNodePosition(
  deps: BookNodeUsecaseDeps,
  id: string,
  position: BookNode['position']
) {
  const nowIso = getNow(deps).toISOString();
  const prevNodes = deps.getNodesState();
  const existing = prevNodes.find((node) => node.id === id);
  if (!existing) throw new Error(`Book node ${id} not found`);

  deps.updateNodeState(id, { position, updatedAt: nowIso });

  try {
    await deps.nodeRepo.update(id, { position, updatedAt: nowIso });
    enqueueNodeTask('update', existing, { position, updatedAt: nowIso });
  } catch (error) {
    deps.setNodesState(prevNodes);
    throw error;
  }
}

async function updateBookNodeSummary(deps: BookNodeUsecaseDeps, id: string, summary: string | null) {
  const now = getNow(deps).toISOString();
  const prevNodes = deps.getNodesState().slice();
  const existing = prevNodes.find((node) => node.id === id);
  if (!existing) throw new Error(`Book node ${id} not found`);

  deps.updateNodeState(id, { summary, updatedAt: now });

  try {
    await deps.nodeRepo.update(id, { summary, updatedAt: now });
    enqueueNodeTask('update', existing, { summary: summary ?? '', updatedAt: now });
  } catch (error) {
    deps.setNodesState(prevNodes);
    throw error;
  }
}

async function updateBookNode(deps: BookNodeUsecaseDeps, id: string, updates: Partial<BookNode>) {
  const now = getNow(deps).toISOString();
  const prevNodes = deps.getNodesState().slice();
  const existing = prevNodes.find((node) => node.id === id);
  if (!existing) throw new Error(`Book node ${id} not found`);

  const updatesWithTimestamp = { ...updates, updatedAt: now };
  deps.updateNodeState(id, updatesWithTimestamp);

  try {
    await deps.nodeRepo.update(id, updatesWithTimestamp);
    enqueueNodeTask('update', existing, updatesWithTimestamp);
  } catch (error) {
    deps.setNodesState(prevNodes);
    throw error;
  }
}

async function deleteBookNode(deps: BookNodeUsecaseDeps, id: string) {
  log.debug('[deleteBookNode] Starting delete for node:', id);
  const prevNodes = deps.getNodesState().slice();
  const existing = prevNodes.find((node) => node.id === id);
  if (!existing) throw new Error(`Book node ${id} not found`);

  log.debug('[deleteBookNode] Node found, removing from state optimistically');
  // Optimistically remove from state
  const nextNodes = prevNodes.filter((node) => node.id !== id);
  deps.setNodesState(nextNodes);

  try {
    log.debug('[deleteBookNode] Calling repository delete');
    await deps.nodeRepo.delete(id);
    log.debug('[deleteBookNode] Repository delete successful');
    enqueueNodeTask('delete', existing);
  } catch (error) {
    log.error('[deleteBookNode] Repository delete failed, rolling back:', error);
    // Rollback on error
    deps.setNodesState(prevNodes);
    throw error;
  }
}

export async function updateBookNodeEdge(deps: BookNodeUsecaseDeps, id: string, updates: Partial<BookNodeEdge>) {
  const now = getNow(deps).toISOString();
  // TODO: Add optimistic update for edges in BookNodeUsecaseDeps?
  const result = await deps.edgeRepo.update(id, { ...updates, updatedAt: now });
  return result;
}
