/**
 * Threads API Service
 * 
 * 调用后端 /api/projects/:projectId/threads 相关接口
 */

import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// DTO 类型定义
export interface CreateThreadDto {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
}

export interface UpdateThreadDto {
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
}

export interface Thread {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Threads API 客户端
 */
export const threadsApi = {
  /**
   * 获取项目的所有线程
   * GET /api/projects/:projectId/threads
   */
  async getAll(projectId: string): Promise<Thread[]> {
    const response = await axios.get(`${BASE_URL}/api/projects/${projectId}/threads`);
    return response.data;
  },

  /**
   * 创建线程
   * POST /api/projects/:projectId/threads
   */
  async create(projectId: string, dto: CreateThreadDto): Promise<Thread> {
    const response = await axios.post(`${BASE_URL}/api/projects/${projectId}/threads`, dto);
    return response.data;
  },

  /**
   * 更新线程
   * PATCH /api/projects/:projectId/threads/:threadId
   */
  async update(projectId: string, threadId: string, dto: UpdateThreadDto): Promise<Thread> {
    const response = await axios.patch(`${BASE_URL}/api/projects/${projectId}/threads/${threadId}`, dto);
    return response.data;
  },

  /**
   * 删除线程
   * DELETE /api/projects/:projectId/threads/:threadId
   */
  async delete(projectId: string, threadId: string): Promise<void> {
    await axios.delete(`${BASE_URL}/api/projects/${projectId}/threads/${threadId}`);
  },
};
