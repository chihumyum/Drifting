import type { NodeContent } from '../domain/node-content';


export interface BookContentRepository {
  findById(id: string): Promise<NodeContent | null>;
  findByNodeId(nodeId: string): Promise<NodeContent | null>;
  create(data: Partial<NodeContent>): Promise<NodeContent>;
  update(contentId: string, data: Partial<NodeContent>): Promise<NodeContent | null>;
  updateByNodeId(nodeId: string, data: Partial<NodeContent>): Promise<NodeContent | null>;
  deleteById(id: string): Promise<boolean>;
  deleteByNodeId(nodeId: string): Promise<boolean>;
}

