import type { Storyline, CreateStorylineInput, UpdateStorylineInput } from '../domain/storyline';

export interface StorylineRepository {
  // Storyline CRUD
  createStoryline(input: CreateStorylineInput): Promise<Storyline>;
  getStorylineById(id: string): Promise<Storyline | null>;
  getStorylinesByProject(projectId: string): Promise<Storyline[]>;
  updateStoryline(input: UpdateStorylineInput): Promise<Storyline>;
  deleteStoryline(id: string): Promise<void>;
  
  // Node-Storyline relationships
  addNodeToStoryline(nodeId: string, storylineId: string): Promise<void>;
  removeNodeFromStoryline(nodeId: string, storylineId: string): Promise<void>;
  getStorylinesByNode(nodeId: string): Promise<Storyline[]>;
  getNodeIdsByStoryline(storylineId: string): Promise<string[]>;
  setNodeStorylines(nodeId: string, storylineIds: string[]): Promise<void>;
}
