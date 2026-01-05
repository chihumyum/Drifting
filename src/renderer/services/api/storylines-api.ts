/**
 * Storylines API Service
 *
 * 调用后端 /api/projects/:projectId/storylines 相关接口
 */

import apiClient from '../../lib/axios-config';

export interface CreateStorylineDto {
  id?: string;
  name: string;
  color: string;
  summary?: string;
  pmJson?: Record<string, unknown>;
  nodeIds?: string[];
}

export interface UpdateStorylineDto {
  name?: string;
  color?: string;
  summary?: string;
  pmJson?: Record<string, unknown>;
  nodeIds?: string[];
}

export interface Storyline {
  id: string;
  projectId: string;
  name: string;
  color: string;
  summary?: string;
  pmJson?: Record<string, unknown>;
  nodeIds: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  isDeleted?: boolean;
}

export interface ListStorylinesResponse {
  items: Storyline[];
  nextCursor: string | null;
}

/**
 * Storylines API 客户端
 */
export const storylinesApi = {
  /**
   * 获取项目的所有故事线
   * GET /api/projects/:projectId/storylines
   */
  async list(
    projectId: string,
    options?: { updatedAfter?: number; cursor?: string; limit?: number; includeDeleted?: boolean }
  ): Promise<ListStorylinesResponse> {
    const response = await apiClient.get<ListStorylinesResponse>(`/api/projects/${projectId}/storylines`, {
      params: {
        ...(options?.updatedAfter ? { updatedAfter: options.updatedAfter } : {}),
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        ...(options?.limit ? { limit: options.limit } : {}),
        ...(options?.includeDeleted ? { includeDeleted: true } : {}),
      },
    });
    return response.data;
  },

  /**
   * 创建故事线
   * POST /api/projects/:projectId/storylines
   */
  async create(projectId: string, dto: CreateStorylineDto): Promise<Storyline> {
    const response = await apiClient.post<Storyline>(`/api/projects/${projectId}/storylines`, dto);
    return response.data;
  },

  /**
   * 更新故事线
   * PATCH /api/projects/:projectId/storylines/:storylineId
   */
  async update(projectId: string, storylineId: string, dto: UpdateStorylineDto): Promise<Storyline> {
    const response = await apiClient.patch<Storyline>(`/api/projects/${projectId}/storylines/${storylineId}`, dto);
    return response.data;
  },

  /**
   * 删除故事线
   * DELETE /api/projects/:projectId/storylines/:storylineId
   */
  async delete(projectId: string, storylineId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/storylines/${storylineId}`);
  },
};
