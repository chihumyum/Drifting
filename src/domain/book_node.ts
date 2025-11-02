import type { NodeType, NodeStatus, NodeEdgeKind } from '../schema/book_node';

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
  kind: NodeEdgeKind;
  label: string | null;
  weight: number;
  createdAt: string;
}

export interface BookNodeElementLink {
  id: string;
  nodeId: string;
  elementId: string;
}

