/**
 * Projects API Service
 * 
 * 调用后端 /api/projects 相关接口
 */

import apiClient from '../../lib/axios-config';

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

type ServerProject = {
  id: string;
  ownerId: string;
  name?: string;
  title?: string;
  description?: string | null;
  coverImageUrl?: string | null;
  coverImage?: string | null;
  createdAt: string;
  updatedAt: string;
};

const mapProjectFromServer = (data: ServerProject): Project => {
  return {
    id: data.id,
    ownerId: data.ownerId,
    title: data.name ?? data.title ?? '',
    description: data.description ?? undefined,
    coverImage: data.coverImageUrl ?? data.coverImage ?? undefined,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
};

/**
 * Projects API 客户端
 */
export const projectsApi = {
  /**
   * 获取用户的所有项目
   * GET /api/projects
   */
  async getAll(): Promise<Project[]> {
    const response = await apiClient.get('/api/projects');
    return (response.data as ServerProject[]).map(mapProjectFromServer);
  },

  /**
   * 创建项目
   * POST /api/projects
   */
  async create(dto: CreateProjectDto): Promise<Project> {
    const payload = {
      name: dto.title,
      description: dto.description,
      coverImageUrl: dto.coverImage,
    };
    const response = await apiClient.post('/api/projects', payload);
    return mapProjectFromServer(response.data as ServerProject);
  },

  /**
   * 获取单个项目
   * GET /api/projects/:id
   */
  async getById(id: string): Promise<Project> {
    const response = await apiClient.get(`/api/projects/${id}`);
    return mapProjectFromServer(response.data as ServerProject);
  },

  /**
   * 更新项目
   * PATCH /api/projects/:id
   */
  async update(id: string, dto: UpdateProjectDto): Promise<Project> {
    const payload: Record<string, unknown> = {};
    if (dto.title !== undefined) payload.name = dto.title;
    if (dto.description !== undefined) payload.description = dto.description;
    if (dto.coverImage !== undefined) payload.coverImageUrl = dto.coverImage;
    const response = await apiClient.patch(`/api/projects/${id}`, payload);
    return mapProjectFromServer(response.data as ServerProject);
  },

  /**
   * 删除项目
   * DELETE /api/projects/:id
   */
  async delete(id: string): Promise<void> {
    await apiClient.delete(`/api/projects/${id}`);
  },

  /**
   * 添加协作者
   * POST /api/projects/:id/collaborators
   */
  async addCollaborator(projectId: string, dto: UpdateCollaboratorDto): Promise<void> {
    await apiClient.post(`/api/projects/${projectId}/collaborators`, dto);
  },

  /**
   * 移除协作者
   * DELETE /api/projects/:id/collaborators/:collaboratorId
   */
  async removeCollaborator(projectId: string, collaboratorId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/collaborators/${collaboratorId}`);
  },
};
