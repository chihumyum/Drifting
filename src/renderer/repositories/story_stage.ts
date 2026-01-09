// Repository interfaces for Story Stage and Node Tag
import type { StoryStage, NodeTag, NodeTagLink } from '../domain/node-tag';

// Story Stage Repository
export interface StoryStageRepository {
  findById(id: string): Promise<StoryStage | null>;
  findAll(projectId: string): Promise<StoryStage[]>;
  create(data: Omit<StoryStage, 'id' | 'createdAt' | 'updatedAt'>): Promise<StoryStage>;
  update(id: string, data: Partial<StoryStage>): Promise<StoryStage | null>;
  delete(id: string): Promise<boolean>;
}

// Node Tag Repository
export interface NodeTagRepository {
  findById(id: string): Promise<NodeTag | null>;
  findAll(projectId: string): Promise<NodeTag[]>;
  findByName(projectId: string, name: string): Promise<NodeTag | null>;
  create(data: Omit<NodeTag, 'id' | 'createdAt'>): Promise<NodeTag>;
  delete(id: string): Promise<boolean>;
}

// Node Tag Link Repository (for many-to-many relationship)
export interface NodeTagLinkRepository {
  // Get all tags for a node
  findTagsByNodeId(nodeId: string): Promise<NodeTag[]>;
  // Get all nodes with a specific tag
  findNodeIdsByTagId(tagId: string): Promise<string[]>;
  // Link a tag to a node
  addTagToNode(nodeId: string, tagId: string): Promise<NodeTagLink>;
  // Remove a tag from a node
  removeTagFromNode(nodeId: string, tagId: string): Promise<boolean>;
  // Remove all tags from a node
  removeAllTagsFromNode(nodeId: string): Promise<boolean>;
}
