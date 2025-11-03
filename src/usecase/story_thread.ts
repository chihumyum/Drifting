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

  async getMainThread(projectId: string): Promise<StoryThread | null> {
    return this.repo.getMainThread(projectId);
  }

  async ensureMainThread(projectId: string): Promise<StoryThread> {
    let mainThread = await this.repo.getMainThread(projectId);
    if (!mainThread) {
      mainThread = await this.repo.createThread({
        projectId,
        name: 'Main Story',
        color: '#3B82F6', // Blue
        summary: 'Main storyline',
        isMain: true,
      });
    }
    return mainThread;
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

  async assignMainThreadToNode(nodeId: string, projectId: string): Promise<void> {
    const mainThread = await this.ensureMainThread(projectId);
    await this.repo.addNodeToThread(nodeId, mainThread.id);
  }
}
