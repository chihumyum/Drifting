import type { BookNode } from '../domain/book_node';
import type { BookNodeRecord, NodeEdge, NodeType } from '../schema/book_node';

export interface BookNodeRepository {
  findById(id: string): Promise<BookNodeRecord | null>;
  findAll(projectId?: string): Promise<BookNodeRecord[]>;
  findAllByType(type: NodeType, projectId?: string): Promise<BookNodeRecord[]>;
  create(data: Partial<BookNodeRecord>): Promise<BookNodeRecord>;
  update(id: string, data: Partial<BookNodeRecord>): Promise<BookNodeRecord | null>;
  delete(id: string): Promise<boolean>;
  swapOrder(first: Pick<BookNode, 'id' | 'orderKey'>, second: Pick<BookNode, 'id' | 'orderKey'>): Promise<void>;
}

export interface BookNodeEdgeRepository {
  findAll(projectId?: string): Promise<NodeEdge[]>;
  create(data: Partial<NodeEdge>): Promise<NodeEdge>;
  delete(id: string): Promise<boolean>;
}

export interface BookNodeDataSource {
  nodeRepo: BookNodeRepository;
  edgeRepo: BookNodeEdgeRepository;
}
