import type { StoryThread, CreateStoryThreadInput, UpdateStoryThreadInput } from '../domain/story_thread';

export interface StoryThreadRepository {
  // Thread CRUD
  createThread(input: CreateStoryThreadInput): Promise<StoryThread>;
  getThreadById(id: string): Promise<StoryThread | null>;
  getThreadsByProject(projectId: string): Promise<StoryThread[]>;
  updateThread(input: UpdateStoryThreadInput): Promise<StoryThread>;
  deleteThread(id: string): Promise<void>;
  getMainThread(projectId: string): Promise<StoryThread | null>;
  
  // Node-Thread relationships
  addNodeToThread(nodeId: string, threadId: string): Promise<void>;
  removeNodeFromThread(nodeId: string, threadId: string): Promise<void>;
  getThreadsByNode(nodeId: string): Promise<StoryThread[]>;
  getNodeIdsByThread(threadId: string): Promise<string[]>;
  setNodeThreads(nodeId: string, threadIds: string[]): Promise<void>;
}
