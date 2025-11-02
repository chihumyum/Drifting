import type { BookNode, BookNodeEdge, BookNodePosition, BookNodeStatus } from '../domain/book_node';
import type { NodeType, NodeStatus } from '../schema/book_node';

type PositionInput = Partial<BookNodePosition> | undefined;

export interface BookNodeCreateData {
  id?: string;
  projectId?: string;
  parentId?: string | null;
  title: string;
  type?: NodeType;
  orderKey?: number;
  status?: BookNodeStatus;
  summary?: string | null;
  position?: PositionInput;
  createdAt?: string;
  updatedAt?: string;
}

export interface BookNodeUpdateData {
  projectId?: string;
  parentId?: string | null;
  title?: string;
  type?: NodeType;
  orderKey?: number;
  status?: BookNodeStatus;
  summary?: string | null;
  position?: PositionInput;
  createdAt?: string;
  updatedAt?: string;
}

export interface BookNodeEdgeCreateData {
  id?: string;
  projectId?: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind?: BookNodeEdge['kind'];
  label?: string | null;
  weight?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface BookNodeRepository {
  findById(id: string): Promise<BookNode | null>;
  findAll(projectId?: string): Promise<BookNode[]>;
  findAllByType(type: NodeType, projectId?: string): Promise<BookNode[]>;
  create(data: BookNodeCreateData): Promise<BookNode>;
  update(id: string, data: BookNodeUpdateData): Promise<BookNode | null>;
  delete(id: string): Promise<boolean>;
  swapOrder(first: Pick<BookNode, 'id' | 'orderKey'>, second: Pick<BookNode, 'id' | 'orderKey'>): Promise<void>;
}

export interface BookNodeEdgeRepository {
  findAll(projectId?: string): Promise<BookNodeEdge[]>;
  create(data: BookNodeEdgeCreateData): Promise<BookNodeEdge>;
  delete(id: string): Promise<boolean>;
}

export interface BookNodeDataSource {
  nodeRepo: BookNodeRepository;
  edgeRepo: BookNodeEdgeRepository;
}
export const DEFAULT_BOOK_NODE_STATUS: NodeStatus = 'draft';
