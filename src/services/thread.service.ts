import apiClient, { handleApiError } from '../lib/api';
import type { StoryThread } from '../domain/story_thread';

export interface CreateStoryThreadInput {
  projectId: string;
  name: string;
  color: string;
  summary?: string;
  pmJson?: object;
}

export interface UpdateStoryThreadInput {
  id: string;
  name?: string;
  color?: string;
  summary?: string;
  pmJson?: object;
}

/**
 * 故事线服务 - 对应后端 /threads API
 */
export const threadService = {
  /**
   * 创建新故事线
   */
  async createThread(input: CreateStoryThreadInput): Promise<StoryThread> {
    try {
      const response = await apiClient.post<StoryThread>('/threads', input);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create thread: ${handleApiError(error)}`);
    }
  },

  /**
   * 根据 ID 获取故事线
   */
  async getThreadById(id: string): Promise<StoryThread | null> {
    try {
      const response = await apiClient.get<StoryThread>(`/threads/${id}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch thread:', handleApiError(error));
      return null;
    }
  },

  /**
   * 根据项目获取所有故事线
   */
  async getThreadsByProject(projectId: string): Promise<StoryThread[]> {
    try {
      const response = await apiClient.get<StoryThread[]>('/threads', {
        params: { projectId },
      });
      return response.data;
    } catch (error) {
      console.error('Failed to fetch threads:', handleApiError(error));
      return [];
    }
  },

  /**
   * 更新故事线
   */
  async updateThread(input: UpdateStoryThreadInput): Promise<StoryThread> {
    try {
      const { id, ...updates } = input;
      const response = await apiClient.patch<StoryThread>(`/threads/${id}`, updates);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to update thread: ${handleApiError(error)}`);
    }
  },

  /**
   * 删除故事线
   */
  async deleteThread(id: string): Promise<void> {
    try {
      await apiClient.delete(`/threads/${id}`);
    } catch (error) {
      throw new Error(`Failed to delete thread: ${handleApiError(error)}`);
    }
  },

  /**
   * 将节点添加到故事线
   */
  async addNodeToThread(nodeId: string, threadId: string): Promise<void> {
    try {
      await apiClient.post(`/threads/${threadId}/nodes/${nodeId}`);
    } catch (error) {
      throw new Error(`Failed to add node to thread: ${handleApiError(error)}`);
    }
  },

  /**
   * 从故事线中移除节点
   */
  async removeNodeFromThread(nodeId: string, threadId: string): Promise<void> {
    try {
      await apiClient.delete(`/threads/${threadId}/nodes/${nodeId}`);
    } catch (error) {
      throw new Error(`Failed to remove node from thread: ${handleApiError(error)}`);
    }
  },

  /**
   * 根据节点获取所有相关故事线
   */
  async getThreadsByNode(nodeId: string): Promise<StoryThread[]> {
    try {
      const response = await apiClient.get<StoryThread[]>(`/threads/by-node/${nodeId}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch threads by node:', handleApiError(error));
      return [];
    }
  },

  /**
   * 根据故事线获取所有节点 ID
   */
  async getNodeIdsByThread(threadId: string): Promise<string[]> {
    try {
      const response = await apiClient.get<string[]>(`/threads/${threadId}/nodes`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch node IDs by thread:', handleApiError(error));
      return [];
    }
  },

  /**
   * 设置节点的所有故事线
   * TODO: 后端需要实现这个 API
   */
  async setNodeThreads(nodeId: string, threadIds: string[]): Promise<void> {
    try {
      await apiClient.put(`/nodes/${nodeId}/threads`, { threadIds });
    } catch (error) {
      throw new Error(`Failed to set node threads: ${handleApiError(error)}`);
    }
  },
};
