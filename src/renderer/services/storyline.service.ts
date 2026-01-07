import apiClient, { handleApiError } from '../lib/api';
import type { Storyline } from '../domain/storyline';
import log from "loglevel";

log.setLevel(log.levels.ERROR);

export interface CreateStorylineInput {
  projectId: string;
  name: string;
  color: string;
  summary?: string;
  pmJson?: object;
}

export interface UpdateStorylineInput {
  id: string;
  name?: string;
  color?: string;
  summary?: string;
  pmJson?: object;
}

/**
 * 故事线服务 - 对应后端 /storylines API
 */
export const storylineService = {
  /**
   * 创建新故事线
   */
  async createStoryline(input: CreateStorylineInput): Promise<Storyline> {
    try {
      const response = await apiClient.post<Storyline>('/storylines', input);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create storyline: ${handleApiError(error)}`);
    }
  },

  /**
   * 根据 ID 获取故事线
   */
  async getStorylineById(id: string): Promise<Storyline | null> {
    try {
      const response = await apiClient.get<Storyline>(`/storylines/${id}`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch storyline:', handleApiError(error));
      return null;
    }
  },

  /**
   * 根据项目获取所有故事线
   */
  async getStorylinesByProject(projectId: string): Promise<Storyline[]> {
    try {
      const response = await apiClient.get<Storyline[]>('/storylines', {
        params: { projectId },
      });
      return response.data;
    } catch (error) {
      log.error('Failed to fetch storylines:', handleApiError(error));
      return [];
    }
  },

  /**
   * 更新故事线
   */
  async updateStoryline(input: UpdateStorylineInput): Promise<Storyline> {
    try {
      const { id, ...updates } = input;
      const response = await apiClient.patch<Storyline>(`/storylines/${id}`, updates);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to update storyline: ${handleApiError(error)}`);
    }
  },

  /**
   * 删除故事线
   */
  async deleteStoryline(id: string): Promise<void> {
    try {
      await apiClient.delete(`/storylines/${id}`);
    } catch (error) {
      throw new Error(`Failed to delete storyline: ${handleApiError(error)}`);
    }
  },

  /**
   * 将节点添加到故事线
   */
  async addNodeToStoryline(nodeId: string, storylineId: string): Promise<void> {
    try {
      await apiClient.post(`/storylines/${storylineId}/nodes/${nodeId}`);
    } catch (error) {
      throw new Error(`Failed to add node to storyline: ${handleApiError(error)}`);
    }
  },

  /**
   * 从故事线中移除节点
   */
  async removeNodeFromStoryline(nodeId: string, storylineId: string): Promise<void> {
    try {
      await apiClient.delete(`/storylines/${storylineId}/nodes/${nodeId}`);
    } catch (error) {
      throw new Error(`Failed to remove node from storyline: ${handleApiError(error)}`);
    }
  },

  /**
   * 根据节点获取所有相关故事线
   */
  async getStorylinesByNode(nodeId: string): Promise<Storyline[]> {
    try {
      const response = await apiClient.get<Storyline[]>(`/storylines/by-node/${nodeId}`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch storylines by node:', handleApiError(error));
      return [];
    }
  },

  /**
   * 根据故事线获取所有节点 ID
   */
  async getNodeIdsByStoryline(storylineId: string): Promise<string[]> {
    try {
      const response = await apiClient.get<string[]>(`/storylines/${storylineId}/nodes`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch node IDs by storyline:', handleApiError(error));
      return [];
    }
  },

  /**
   * 设置节点的所有故事线
   * TODO: 后端需要实现这个 API
   */
  async setNodeStorylines(nodeId: string, storylineIds: string[]): Promise<void> {
    try {
      await apiClient.put(`/nodes/${nodeId}/storylines`, { storylineIds });
    } catch (error) {
      throw new Error(`Failed to set node storylines: ${handleApiError(error)}`);
    }
  },
};
