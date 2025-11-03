// operations related to book nodes & node edges
import type {BookNode, BookNodeEdge } from '../domain/book_node';
import { DEFAULT_BOOK_NODE_STATUS } from '../repositories/book_node';
import type { BookNodeEdgeRepository, BookNodeRepository } from '../repositories/book_node';
import type { StoryThreadRepository } from '../repositories/story_thread';
import type { NodeType } from '../schema/book_node';

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
  threadRepo: StoryThreadRepository;
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

async function loadBookNodes(deps: BookNodeUsecaseDeps, options?: { projectId?: string; type?: NodeType }) {
  const nodes = options?.type
    ? await deps.nodeRepo.findAllByType(options.type, options?.projectId)
    : await deps.nodeRepo.findAll(options?.projectId);
  const sorted = nodes.slice().sort((a, b) => a.orderKey - b.orderKey);
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
  type?: NodeType;
  parentId?: string | null;
  projectId?: string;
  summary?: string | null;
  status?: BookNode['status'];
  orderKey?: number;
  position?: BookNode['position'];
}

async function createBookNode(deps: BookNodeUsecaseDeps, input: CreateBookNodeInput) {
  const now = getNow(deps);
  const nodes = deps.getNodesState();
  const filtered = input.type ? nodes.filter((n) => n.type === input.type) : nodes;
  const maxOrder = filtered.reduce((max, node) => Math.max(max, node.orderKey), Number.NEGATIVE_INFINITY);
  const nextOrder = Number.isFinite(maxOrder) ? maxOrder + 1 : 1;

  const created = await deps.nodeRepo.create({
    title: input.title,
    type: input.type ?? 'chapter',
    projectId: input.projectId,
    parentId: input.parentId ?? null,
    orderKey: input.orderKey ?? nextOrder,
    status: input.status ?? DEFAULT_BOOK_NODE_STATUS,
    summary: input.summary ?? null,
    position: input.position,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  // Assign main thread to new node
  const projectId = input.projectId ?? 'default-project';
  try {
    let mainThread = await deps.threadRepo.getMainThread(projectId);
    if (!mainThread) {
      // Create main thread if it doesn't exist
      mainThread = await deps.threadRepo.createThread({
        projectId,
        name: 'Main Story',
        color: '#3B82F6',
        summary: 'Main storyline',
        isMain: true,
      });
    }
    await deps.threadRepo.addNodeToThread(created.id, mainThread.id);
  } catch (error) {
    console.error('Failed to assign main thread to new node:', error);
  }

  const node = created;
  const nextNodes = [...nodes, node].sort((a, b) => a.orderKey - b.orderKey);
  deps.setNodesState(nextNodes);
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
  } catch (error) {
    deps.setNodesState(prevNodes);
    throw error;
  }
}

async function reorderBookNode(deps: BookNodeUsecaseDeps, id: string, direction: 'up' | 'down') {
  const nodes = deps.getNodesState().slice().sort((a, b) => a.orderKey - b.orderKey);
  const index = nodes.findIndex((node) => node.id === id);
  if (index === -1) return;

  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= nodes.length) return;

  const current = nodes[index];
  const target = nodes[swapIndex];
  const currentOrder = current.orderKey;
  const targetOrder = target.orderKey;
  const now = getNow(deps).toISOString();

  const nextNodes = nodes.map((node) => {
    if (node.id === current.id) {
      return { ...node, orderKey: targetOrder, updatedAt: now };
    }
    if (node.id === target.id) {
      return { ...node, orderKey: currentOrder, updatedAt: now };
    }
    return node;
  }).sort((a, b) => a.orderKey - b.orderKey);

  const prev = deps.getNodesState().slice();
  deps.setNodesState(nextNodes);

  try {
    await deps.nodeRepo.swapOrder({ id: current.id, orderKey: currentOrder }, { id: target.id, orderKey: targetOrder });
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
  } catch (error) {
    deps.setNodesState(prevNodes);
    throw error;
  }
}

async function deleteBookNode(deps: BookNodeUsecaseDeps, id: string) {
  const prevNodes = deps.getNodesState().slice();
  const existing = prevNodes.find((node) => node.id === id);
  if (!existing) throw new Error(`Book node ${id} not found`);

  // Optimistically remove from state
  const nextNodes = prevNodes.filter((node) => node.id !== id);
  deps.setNodesState(nextNodes);

  try {
    await deps.nodeRepo.delete(id);
  } catch (error) {
    // Rollback on error
    deps.setNodesState(prevNodes);
    throw error;
  }
}
