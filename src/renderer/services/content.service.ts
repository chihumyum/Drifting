import apiClient, { handleApiError } from '../lib/api';
import type { NodeContent } from '../domain/node-content';
import log from "loglevel";

log.setLevel(log.levels.ERROR);

/**
 * 内容服务 - 对应后端 /nodes/:nodeId/content API
 */
export const contentService = {
  /**
   * 根据内容 ID 获取内容
   */
  async findById(id: string): Promise<NodeContent | null> {
    try {
      const response = await apiClient.get<NodeContent>(`/nodes/content/${id}`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch content:', handleApiError(error));
      return null;
    }
  },

  /**
   * 根据节点 ID 获取内容
   */
  async findByNodeId(nodeId: string): Promise<NodeContent | null> {
    try {
      const response = await apiClient.get<NodeContent>(`/nodes/${nodeId}/content`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch content by node ID:', handleApiError(error));
      return null;
    }
  },

  /**
   * 创建新内容
   */
  async create(data: Partial<NodeContent>): Promise<NodeContent> {
    try {
      if (!data.nodeId) {
        throw new Error('nodeId is required');
      }
      const response = await apiClient.post<NodeContent>(`/nodes/${data.nodeId}/content`, data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create content: ${handleApiError(error)}`);
    }
  },

  /**
   * 根据内容 ID 更新内容
   */
  async update(id: string, data: Partial<NodeContent>): Promise<NodeContent | null> {
    try {
      const response = await apiClient.patch<NodeContent>(`/nodes/content/${id}`, data);
      return response.data;
    } catch (error) {
      log.error('Failed to update content:', handleApiError(error));
      return null;
    }
  },

  /**
   * 根据节点 ID 更新内容
   */
  async updateByNodeId(nodeId: string, data: Partial<NodeContent>): Promise<NodeContent | null> {
    try {
      const response = await apiClient.patch<NodeContent>(`/nodes/${nodeId}/content`, data);
      return response.data;
    } catch (error) {
      log.error('Failed to update content by node ID:', handleApiError(error));
      return null;
    }
  },

  /**
   * 根据内容 ID 删除内容
   */
  async deleteById(id: string): Promise<boolean> {
    try {
      await apiClient.delete(`/nodes/content/${id}`);
      return true;
    } catch (error) {
      log.error('Failed to delete content:', handleApiError(error));
      return false;
    }
  },

  /**
   * 根据节点 ID 删除内容
   */
  async deleteByNodeId(nodeId: string): Promise<boolean> {
    try {
      await apiClient.delete(`/nodes/${nodeId}/content`);
      return true;
    } catch (error) {
      log.error('Failed to delete content by node ID:', handleApiError(error));
      return false;
    }
  },
};
