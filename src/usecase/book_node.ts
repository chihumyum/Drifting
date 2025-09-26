import { DEFAULT_BOOK_NODE_STATUS, toBookNode, toBookNodeEdge, type BookNode, type BookNodeEdge } from '../domain/book_node';
import type { BookNodeEdgeRepository, BookNodeRepository } from '../repositories/book_node';
import type { NodeType } from '../schema/book_node';

export interface BookNodeUsecaseDeps {
  nodeRepo: BookNodeRepository;
  edgeRepo: BookNodeEdgeRepository;
  getNodes: () => BookNode[];
  setNodes: (nodes: BookNode[]) => void;
  updateNode: (id: string, updates: Partial<BookNode>) => void;
  setEdges: (edges: BookNodeEdge[]) => void;
  now?: () => Date;
}

function getNow(deps: BookNodeUsecaseDeps) {
  return (deps.now ?? (() => new Date()))();
}

export async function loadBookNodes(deps: BookNodeUsecaseDeps, options?: { projectId?: string; type?: NodeType }) {
  const records = options?.type
    ? await deps.nodeRepo.findAllByType(options.type, options?.projectId)
    : await deps.nodeRepo.findAll(options?.projectId);
  const nodes = records.map(toBookNode).sort((a, b) => a.orderKey - b.orderKey);
  deps.setNodes(nodes);
  return nodes;
}

export async function loadBookNodeEdges(deps: BookNodeUsecaseDeps, projectId?: string) {
  const records = await deps.edgeRepo.findAll(projectId);
  const edges = records.map(toBookNodeEdge);
  deps.setEdges(edges);
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

export async function createBookNode(deps: BookNodeUsecaseDeps, input: CreateBookNodeInput) {
  const now = getNow(deps);
  const nodes = deps.getNodes();
  const filtered = input.type ? nodes.filter((n) => n.type === input.type) : nodes;
  const maxOrder = filtered.reduce((max, node) => Math.max(max, node.orderKey), Number.NEGATIVE_INFINITY);
  const nextOrder = Number.isFinite(maxOrder) ? maxOrder + 1 : 1;

  const record = await deps.nodeRepo.create({
    title: input.title,
    type: input.type ?? 'chapter',
    project_id: input.projectId,
    parent_id: input.parentId ?? null,
    order_key: input.orderKey ?? nextOrder,
    status: input.status ?? DEFAULT_BOOK_NODE_STATUS,
    summary: input.summary ?? null,
    pos_x: input.position?.x ?? null,
    pos_y: input.position?.y ?? null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });

  const node = toBookNode(record);
  const nextNodes = [...nodes, node].sort((a, b) => a.orderKey - b.orderKey);
  deps.setNodes(nextNodes);
  return node;
}

export async function renameBookNode(deps: BookNodeUsecaseDeps, id: string, title: string) {
  const now = getNow(deps).toISOString();
  const prevNodes = deps.getNodes().slice();
  const existing = prevNodes.find((node) => node.id === id);
  if (!existing) throw new Error(`Book node ${id} not found`);

  deps.updateNode(id, { title, updatedAt: now });

  try {
    await deps.nodeRepo.update(id, { title, updated_at: now });
  } catch (error) {
    deps.setNodes(prevNodes);
    throw error;
  }
}

export async function reorderBookNode(deps: BookNodeUsecaseDeps, id: string, direction: 'up' | 'down') {
  const nodes = deps.getNodes().slice().sort((a, b) => a.orderKey - b.orderKey);
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

  const prev = deps.getNodes().slice();
  deps.setNodes(nextNodes);

  try {
    await deps.nodeRepo.swapOrder({ id: current.id, orderKey: currentOrder }, { id: target.id, orderKey: targetOrder });
  } catch (error) {
    deps.setNodes(prev);
    throw error;
  }
}

export async function updateBookNodePosition(
  deps: BookNodeUsecaseDeps,
  id: string,
  position: BookNode['position']
) {
  const nowIso = getNow(deps).toISOString();
  const prevNodes = deps.getNodes();
  const existing = prevNodes.find((node) => node.id === id);
  if (!existing) throw new Error(`Book node ${id} not found`);

  deps.updateNode(id, { position, updatedAt: nowIso });

  try {
    await deps.nodeRepo.update(id, { pos_x: position.x, pos_y: position.y, updated_at: nowIso });
  } catch (error) {
    deps.setNodes(prevNodes);
    throw error;
  }
}
