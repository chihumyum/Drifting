import apiClient, { handleApiError } from '../lib/api';
import type { BookNode } from '../domain/book-node';
import log from "loglevel";

log.setLevel(log.levels.ERROR);

export interface BookNodeCreateData {
  projectId: string;
  name: string;
  summary?: string;
  start: number;
  pmJson?: object;
  posX?: number;
  posY?: number;
  nodeOrder?: number;
}

export interface BookNodeUpdateData {
  name?: string;
  summary?: string;
  start?: number;
  pmJson?: object;
  posX?: number;
  posY?: number;
  nodeOrder?: number;
}

export interface BookNodeEdge {
  fromId: string;
  toId: string;
  edgeType?: string;
}

/**
 * 节点服务 - 对应后端 /nodes API
 */
export const nodeService = {
  /**
   * 根据 ID 获取节点
   */
  async findById(id: string): Promise<BookNode | null> {
    try {
      const response = await apiClient.get<BookNode>(`/nodes/${id}`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch node:', handleApiError(error));
      return null;
    }
  },

  /**
   * 获取所有节点（可按项目过滤）
   */
  async findAll(projectId?: string): Promise<BookNode[]> {
    try {
      const params = projectId ? { projectId } : {};
      const response = await apiClient.get<BookNode[]>('/nodes', { params });
      return response.data;
    } catch (error) {
      log.error('Failed to fetch nodes:', handleApiError(error));
      return [];
    }
  },

  /**
   * 创建新节点
   */
  async create(data: BookNodeCreateData): Promise<BookNode> {
    try {
      const response = await apiClient.post<BookNode>('/nodes', data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create node: ${handleApiError(error)}`);
    }
  },

  /**
   * 更新节点
   */
  async update(id: string, updates: BookNodeUpdateData): Promise<BookNode> {
    try {
      const response = await apiClient.patch<BookNode>(`/nodes/${id}`, updates);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to update node: ${handleApiError(error)}`);
    }
  },

  /**
   * 删除节点
   */
  async delete(id: string): Promise<void> {
    try {
      await apiClient.delete(`/nodes/${id}`);
    } catch (error) {
      throw new Error(`Failed to delete node: ${handleApiError(error)}`);
    }
  },

  /**
   * 交换两个节点的顺序
   * TODO: 后端需要实现这个 API
   */
  async swapOrder(
    first: { id: string; order: number },
    second: { id: string; order: number }
  ): Promise<void> {
    try {
      await apiClient.post('/nodes/swap-order', { first, second });
    } catch (error) {
      throw new Error(`Failed to swap node order: ${handleApiError(error)}`);
    }
  },

  /**
   * 获取节点的内容
   */
  async getContent(nodeId: string): Promise<string> {
    try {
      const response = await apiClient.get<{ content: string }>(`/nodes/${nodeId}/content`);
      return response.data.content || '';
    } catch (error) {
      log.error('Failed to fetch node content:', handleApiError(error));
      return '';
    }
  },

  /**
   * 更新节点的内容
   */
  async updateContent(nodeId: string, content: string): Promise<void> {
    try {
      await apiClient.patch(`/nodes/${nodeId}/content`, { content });
    } catch (error) {
      throw new Error(`Failed to update node content: ${handleApiError(error)}`);
    }
  },
};

/**
 * 节点边服务 - 对应后端 /nodes/edges API
 * TODO: 后端需要实现这些 API
 */
export const nodeEdgeService = {
  /**
   * 获取所有边（可按节点过滤）
   */
  async findAll(nodeId?: string): Promise<BookNodeEdge[]> {
    try {
      const params = nodeId ? { nodeId } : {};
      const response = await apiClient.get<BookNodeEdge[]>('/nodes/edges', { params });
      return response.data;
    } catch (error) {
      log.error('Failed to fetch node edges:', handleApiError(error));
      return [];
    }
  },

  /**
   * 创建新的边
   */
  async create(edge: BookNodeEdge): Promise<BookNodeEdge> {
    try {
      const response = await apiClient.post<BookNodeEdge>('/nodes/edges', edge);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create node edge: ${handleApiError(error)}`);
    }
  },

  /**
   * 删除边
   */
  async delete(fromId: string, toId: string): Promise<void> {
    try {
      await apiClient.delete('/nodes/edges', {
        params: { fromId, toId },
      });
    } catch (error) {
      throw new Error(`Failed to delete node edge: ${handleApiError(error)}`);
    }
  },
};
