/**
 * Projects API Service
 *
 * Backend contract:
 *   project table: { id, userId, name, descriptionJson, createdAt, updatedAt }
 */

import apiClient from '../../lib/axios-config';

// DTO 类型定义
export interface CreateProjectDto {
  id: string;
  title: string;
  descriptionJson?: string;
}

export interface UpdateProjectDto {
  title?: string;
  descriptionJson?: string;
}

export interface Project {
  id: string;
  title: string;
  descriptionJson?: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

/** Raw shape returned by backend */
type ServerProject = {
  id: string;
  userId: string;
  name: string;
  descriptionJson?: string | null;
  createdAt: string;
  updatedAt: string;
};

const mapProjectFromServer = (data: ServerProject): Project => ({
  id: data.id,
  ownerId: data.userId,
  title: data.name,
  descriptionJson: data.descriptionJson ?? undefined,
  createdAt: data.createdAt,
  updatedAt: data.updatedAt,
});

export const projectsApi = {
  async getAll(): Promise<Project[]> {
    const response = await apiClient.get('/api/projects');
    return (response.data as ServerProject[]).map(mapProjectFromServer);
  },

  async create(dto: CreateProjectDto): Promise<Project> {
    const payload = {
      id: dto.id,
      name: dto.title,
      descriptionJson: dto.descriptionJson,
    };
    const response = await apiClient.post('/api/projects', payload);
    return mapProjectFromServer(response.data as ServerProject);
  },

  async getById(id: string): Promise<Project> {
    const response = await apiClient.get(`/api/projects/${id}`);
    return mapProjectFromServer(response.data as ServerProject);
  },

  async update(id: string, dto: UpdateProjectDto): Promise<Project> {
    const payload: Record<string, unknown> = {};
    if (dto.title !== undefined) payload.name = dto.title;
    if (dto.descriptionJson !== undefined) payload.descriptionJson = dto.descriptionJson;
    const response = await apiClient.patch(`/api/projects/${id}`, payload);
    return mapProjectFromServer(response.data as ServerProject);
  },

  async delete(id: string): Promise<void> {
    await apiClient.delete(`/api/projects/${id}`);
  },

  // Collaborator endpoints — not yet implemented on server. Stubs kept for future.
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
