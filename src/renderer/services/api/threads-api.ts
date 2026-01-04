/**
 * Threads API Service
 *
 * 调用后端 /api/projects/:projectId/threads 相关接口
 */

import apiClient from '../../lib/axios-config';

export interface CreateThreadDto {
  id?: string;
  name: string;
  color: string;
  summary?: string;
  pmJson?: Record<string, unknown>;
  nodeIds?: string[];
}

export interface UpdateThreadDto {
  name?: string;
  color?: string;
  summary?: string;
  pmJson?: Record<string, unknown>;
  nodeIds?: string[];
}

export interface Thread {
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

export interface ListThreadsResponse {
  items: Thread[];
  nextCursor: string | null;
}

/**
 * Threads API 客户端
 */
export const threadsApi = {
  /**
   * 获取项目的所有线程
   * GET /api/projects/:projectId/threads
   */
  async list(
    projectId: string,
    options?: { updatedAfter?: number; cursor?: string; limit?: number; includeDeleted?: boolean }
  ): Promise<ListThreadsResponse> {
    const response = await apiClient.get<ListThreadsResponse>(`/api/projects/${projectId}/threads`, {
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
   * 创建线程
   * POST /api/projects/:projectId/threads
   */
  async create(projectId: string, dto: CreateThreadDto): Promise<Thread> {
    const response = await apiClient.post<Thread>(`/api/projects/${projectId}/threads`, dto);
    return response.data;
  },

  /**
   * 更新线程
   * PATCH /api/projects/:projectId/threads/:threadId
   */
  async update(projectId: string, threadId: string, dto: UpdateThreadDto): Promise<Thread> {
    const response = await apiClient.patch<Thread>(`/api/projects/${projectId}/threads/${threadId}`, dto);
    return response.data;
  },

  /**
   * 删除线程
   * DELETE /api/projects/:projectId/threads/:threadId
   */
  async delete(projectId: string, threadId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/threads/${threadId}`);
  },
};
