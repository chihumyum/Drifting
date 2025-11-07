/**
 * Projects API Service
 * 
 * 调用后端 /api/projects 相关接口
 */

import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// DTO 类型定义
export interface CreateProjectDto {
  title: string;
  description?: string;
  coverImage?: string;
}

export interface UpdateProjectDto {
  title?: string;
  description?: string;
  coverImage?: string;
}

export interface UpdateCollaboratorDto {
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface Project {
  id: string;
  title: string;
  description?: string;
  coverImage?: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Projects API 客户端
 */
export const projectsApi = {
  /**
   * 获取用户的所有项目
   * GET /api/projects
   */
  async getAll(): Promise<Project[]> {
    const response = await axios.get(`${BASE_URL}/api/projects`);
    return response.data;
  },

  /**
   * 创建项目
   * POST /api/projects
   */
  async create(dto: CreateProjectDto): Promise<Project> {
    const response = await axios.post(`${BASE_URL}/api/projects`, dto);
    return response.data;
  },

  /**
   * 获取单个项目
   * GET /api/projects/:id
   */
  async getById(id: string): Promise<Project> {
    const response = await axios.get(`${BASE_URL}/api/projects/${id}`);
    return response.data;
  },

  /**
   * 更新项目
   * PATCH /api/projects/:id
   */
  async update(id: string, dto: UpdateProjectDto): Promise<Project> {
    const response = await axios.patch(`${BASE_URL}/api/projects/${id}`, dto);
    return response.data;
  },

  /**
   * 删除项目
   * DELETE /api/projects/:id
   */
  async delete(id: string): Promise<void> {
    await axios.delete(`${BASE_URL}/api/projects/${id}`);
  },

  /**
   * 添加协作者
   * POST /api/projects/:id/collaborators
   */
  async addCollaborator(projectId: string, dto: UpdateCollaboratorDto): Promise<void> {
    await axios.post(`${BASE_URL}/api/projects/${projectId}/collaborators`, dto);
  },

  /**
   * 移除协作者
   * DELETE /api/projects/:id/collaborators/:collaboratorId
   */
  async removeCollaborator(projectId: string, collaboratorId: string): Promise<void> {
    await axios.delete(`${BASE_URL}/api/projects/${projectId}/collaborators/${collaboratorId}`);
  },
};
