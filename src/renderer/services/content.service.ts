import apiClient, { handleApiError } from '../lib/api';
import type { BookContent } from '../domain/book_content';

/**
 * 内容服务 - 对应后端 /nodes/:nodeId/content API
 */
export const contentService = {
  /**
   * 根据内容 ID 获取内容
   */
  async findById(id: string): Promise<BookContent | null> {
    try {
      const response = await apiClient.get<BookContent>(`/nodes/content/${id}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch content:', handleApiError(error));
      return null;
    }
  },

  /**
   * 根据节点 ID 获取内容
   */
  async findByNodeId(nodeId: string): Promise<BookContent | null> {
    try {
      const response = await apiClient.get<BookContent>(`/nodes/${nodeId}/content`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch content by node ID:', handleApiError(error));
      return null;
    }
  },

  /**
   * 创建新内容
   */
  async create(data: Partial<BookContent>): Promise<BookContent> {
    try {
      if (!data.nodeId) {
        throw new Error('nodeId is required');
      }
      const response = await apiClient.post<BookContent>(`/nodes/${data.nodeId}/content`, data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create content: ${handleApiError(error)}`);
    }
  },

  /**
   * 根据内容 ID 更新内容
   */
  async update(id: string, data: Partial<BookContent>): Promise<BookContent | null> {
    try {
      const response = await apiClient.patch<BookContent>(`/nodes/content/${id}`, data);
      return response.data;
    } catch (error) {
      console.error('Failed to update content:', handleApiError(error));
      return null;
    }
  },

  /**
   * 根据节点 ID 更新内容
   */
  async updateByNodeId(nodeId: string, data: Partial<BookContent>): Promise<BookContent | null> {
    try {
      const response = await apiClient.patch<BookContent>(`/nodes/${nodeId}/content`, data);
      return response.data;
    } catch (error) {
      console.error('Failed to update content by node ID:', handleApiError(error));
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
      console.error('Failed to delete content:', handleApiError(error));
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
      console.error('Failed to delete content by node ID:', handleApiError(error));
      return false;
    }
  },
};
