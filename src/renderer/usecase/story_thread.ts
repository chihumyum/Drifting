import type { StoryThreadRepository } from '../repositories/story_thread';
import type { StoryThread, CreateStoryThreadInput, UpdateStoryThreadInput } from '../domain/story_thread';

export class StoryThreadUsecases {
  private repo: StoryThreadRepository;
  
  constructor(repo: StoryThreadRepository) {
    this.repo = repo;
  }

  // Thread management
  async createThread(input: CreateStoryThreadInput): Promise<StoryThread> {
    return this.repo.createThread(input);
  }

  async getThreadById(id: string): Promise<StoryThread | null> {
    return this.repo.getThreadById(id);
  }

  async getThreadsByProject(projectId: string): Promise<StoryThread[]> {
    return this.repo.getThreadsByProject(projectId);
  }

  async updateThread(input: UpdateStoryThreadInput): Promise<StoryThread> {
    return this.repo.updateThread(input);
  }

  async deleteThread(id: string): Promise<void> {
    return this.repo.deleteThread(id);
  }

  // Node-Thread relationships
  async addNodeToThread(nodeId: string, threadId: string): Promise<void> {
    return this.repo.addNodeToThread(nodeId, threadId);
  }

  async removeNodeFromThread(nodeId: string, threadId: string): Promise<void> {
    return this.repo.removeNodeFromThread(nodeId, threadId);
  }

  async getThreadsByNode(nodeId: string): Promise<StoryThread[]> {
    return this.repo.getThreadsByNode(nodeId);
  }

  async getNodeIdsByThread(threadId: string): Promise<string[]> {
    return this.repo.getNodeIdsByThread(threadId);
  }

  async setNodeThreads(nodeId: string, threadIds: string[]): Promise<void> {
    return this.repo.setNodeThreads(nodeId, threadIds);
  }
}
