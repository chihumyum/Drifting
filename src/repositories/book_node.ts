import type { BookNode, BookNodeEdge, BookNodePosition } from '../domain/book_node';

type PositionInput = Partial<BookNodePosition> | undefined;

export interface BookNodeCreateData {
  id?: string;
  projectId?: string;
  title: string;
  start?: number;
  end?: number | null;
  summary?: string | null;
  storyStageId?: string | null;
  position?: PositionInput;
  createdAt?: string;
  updatedAt?: string;
}

export interface BookNodeUpdateData {
  projectId?: string;
  title?: string;
  start?: number;
  end?: number | null;
  summary?: string | null;
  storyStageId?: string | null;
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
  create(data: BookNodeCreateData): Promise<BookNode>;
  update(id: string, data: BookNodeUpdateData): Promise<BookNode | null>;
  delete(id: string): Promise<boolean>;
  swapOrder(first: Pick<BookNode, 'id' | 'start'>, second: Pick<BookNode, 'id' | 'start'>): Promise<void>;
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
