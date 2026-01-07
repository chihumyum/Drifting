import apiClient, { handleApiError } from '../lib/api';
import type { StoryStage, NodeTag } from '../domain/story_stage';
import log from "loglevel";

log.setLevel(log.levels.ERROR);

/**
 * 故事阶段服务
 * TODO: 后端需要实现这些 API
 */
export const stageService = {
  /**
   * 根据 ID 获取阶段
   */
  async findById(id: string): Promise<StoryStage | null> {
    try {
      const response = await apiClient.get<StoryStage>(`/stages/${id}`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch stage:', handleApiError(error));
      return null;
    }
  },

  /**
   * 根据项目获取所有阶段
   */
  async findAll(projectId: string): Promise<StoryStage[]> {
    try {
      const response = await apiClient.get<StoryStage[]>('/stages', {
        params: { projectId },
      });
      return response.data;
    } catch (error) {
      log.error('Failed to fetch stages:', handleApiError(error));
      return [];
    }
  },

  /**
   * 创建新阶段
   */
  async create(data: Omit<StoryStage, 'id' | 'createdAt' | 'updatedAt'>): Promise<StoryStage> {
    try {
      const response = await apiClient.post<StoryStage>('/stages', data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create stage: ${handleApiError(error)}`);
    }
  },

  /**
   * 更新阶段
   */
  async update(id: string, data: Partial<StoryStage>): Promise<StoryStage | null> {
    try {
      const response = await apiClient.patch<StoryStage>(`/stages/${id}`, data);
      return response.data;
    } catch (error) {
      log.error('Failed to update stage:', handleApiError(error));
      return null;
    }
  },

  /**
   * 删除阶段
   */
  async delete(id: string): Promise<boolean> {
    try {
      await apiClient.delete(`/stages/${id}`);
      return true;
    } catch (error) {
      log.error('Failed to delete stage:', handleApiError(error));
      return false;
    }
  },
};

/**
 * 节点标签服务
 * TODO: 后端需要实现这些 API
 */
export const nodeTagService = {
  /**
   * 根据 ID 获取标签
   */
  async findById(id: string): Promise<NodeTag | null> {
    try {
      const response = await apiClient.get<NodeTag>(`/tags/${id}`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch tag:', handleApiError(error));
      return null;
    }
  },

  /**
   * 根据项目获取所有标签
   */
  async findAll(projectId: string): Promise<NodeTag[]> {
    try {
      const response = await apiClient.get<NodeTag[]>('/tags', {
        params: { projectId },
      });
      return response.data;
    } catch (error) {
      log.error('Failed to fetch tags:', handleApiError(error));
      return [];
    }
  },

  /**
   * 根据名称查找标签
   */
  async findByName(projectId: string, name: string): Promise<NodeTag | null> {
    try {
      const response = await apiClient.get<NodeTag>('/tags', {
        params: { projectId, name },
      });
      return response.data;
    } catch (error) {
      log.error('Failed to fetch tag by name:', handleApiError(error));
      return null;
    }
  },

  /**
   * 创建新标签
   */
  async create(data: Omit<NodeTag, 'id' | 'createdAt'>): Promise<NodeTag> {
    try {
      const response = await apiClient.post<NodeTag>('/tags', data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create tag: ${handleApiError(error)}`);
    }
  },

  /**
   * 删除标签
   */
  async delete(id: string): Promise<boolean> {
    try {
      await apiClient.delete(`/tags/${id}`);
      return true;
    } catch (error) {
      log.error('Failed to delete tag:', handleApiError(error));
      return false;
    }
  },

  /**
   * 根据节点获取所有标签
   */
  async findTagsByNodeId(nodeId: string): Promise<NodeTag[]> {
    try {
      const response = await apiClient.get<NodeTag[]>(`/nodes/${nodeId}/tags`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch tags by node:', handleApiError(error));
      return [];
    }
  },
};
