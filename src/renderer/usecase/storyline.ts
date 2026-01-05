import type { StorylineRepository } from '../repositories/storyline';
import type { Storyline, CreateStorylineInput, UpdateStorylineInput } from '../domain/storyline';

export class StorylineUsecases {
  private repo: StorylineRepository;
  
  constructor(repo: StorylineRepository) {
    this.repo = repo;
  }

  // Storyline management
  async createStoryline(input: CreateStorylineInput): Promise<Storyline> {
    return this.repo.createStoryline(input);
  }

  async getStorylineById(id: string): Promise<Storyline | null> {
    return this.repo.getStorylineById(id);
  }

  async getStorylinesByProject(projectId: string): Promise<Storyline[]> {
    return this.repo.getStorylinesByProject(projectId);
  }

  async updateStoryline(input: UpdateStorylineInput): Promise<Storyline> {
    return this.repo.updateStoryline(input);
  }

  async deleteStoryline(id: string): Promise<void> {
    return this.repo.deleteStoryline(id);
  }

  // Node-Storyline relationships
  async addNodeToStoryline(nodeId: string, storylineId: string): Promise<void> {
    return this.repo.addNodeToStoryline(nodeId, storylineId);
  }

  async removeNodeFromStoryline(nodeId: string, storylineId: string): Promise<void> {
    return this.repo.removeNodeFromStoryline(nodeId, storylineId);
  }

  async getStorylinesByNode(nodeId: string): Promise<Storyline[]> {
    return this.repo.getStorylinesByNode(nodeId);
  }

  async getNodeIdsByStoryline(storylineId: string): Promise<string[]> {
    return this.repo.getNodeIdsByStoryline(storylineId);
  }

  async setNodeStorylines(nodeId: string, storylineIds: string[]): Promise<void> {
    return this.repo.setNodeStorylines(nodeId, storylineIds);
  }
}
