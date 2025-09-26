import type { BookNodeRecord, ElementNodeLink as ElementNodeLinkRecord, NodeEdge as NodeEdgeRecord, NodeStatus, NodeTag as NodeTagRecord, NodeType } from '../schema/book_node';

export interface BookNodePosition {
  x: number | null;
  y: number | null;
}

export interface BookNode {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  type: NodeType;
  orderKey: number;
  status: NodeStatus;
  summary: string | null;
  position: BookNodePosition;
  createdAt: string;
  updatedAt: string;
}

export type BookNodeStatus = NodeStatus;

export interface BookNodeTag {
  id: string;
  nodeId: string;
  name: string;
}

export interface BookNodeEdge {
  id: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: NodeEdgeRecord['kind'];
  label: string | null;
  weight: number;
  createdAt: string;
}

export interface BookNodeElementLink {
  id: string;
  nodeId: string;
  elementId: string;
}

export const DEFAULT_BOOK_NODE_STATUS: BookNodeStatus = 'draft';

export function toBookNode(record: BookNodeRecord): BookNode {
  return {
    id: record.id,
    projectId: record.project_id,
    parentId: record.parent_id ?? null,
    title: record.title,
    type: record.type,
    orderKey: record.order_key,
    status: record.status,
    summary: record.summary ?? null,
    position: {
      x: record.pos_x ?? null,
      y: record.pos_y ?? null,
    },
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function fromBookNode(node: BookNode): BookNodeRecord {
  return {
    id: node.id,
    project_id: node.projectId,
    parent_id: node.parentId ?? null,
    title: node.title,
    type: node.type,
    order_key: node.orderKey,
    status: node.status,
    summary: node.summary ?? null,
    pos_x: node.position.x ?? null,
    pos_y: node.position.y ?? null,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

export function toBookNodeEdge(record: NodeEdgeRecord): BookNodeEdge {
  return {
    id: record.id,
    projectId: record.project_id,
    sourceNodeId: record.src_node_id,
    targetNodeId: record.dst_node_id,
    kind: record.kind,
    label: record.label ?? null,
    weight: record.weight,
    createdAt: record.created_at,
  };
}

export function toBookNodeTag(record: NodeTagRecord): BookNodeTag {
  return {
    id: record.id,
    nodeId: record.node_id,
    name: record.name,
  };
}

export function toBookNodeElementLink(record: ElementNodeLinkRecord): BookNodeElementLink {
  return {
    id: record.id,
    nodeId: record.node_id,
    elementId: record.element_id,
  };
}
