import apiClient, { handleApiError } from '../lib/api';
import log from "loglevel";

log.setLevel(log.levels.ERROR);

export interface Project {
  id: string;
  userId: string;
  projectName: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  projectName: string;
  author: string;
}

export interface UpdateProjectInput {
  projectName?: string;
  author?: string;
}

/**
 * 项目服务 - 对应后端 /projects API
 */
export const projectService = {
  /**
   * 根据 ID 获取项目
   */
  async findById(id: string): Promise<Project | null> {
    try {
      const response = await apiClient.get<Project>(`/projects/${id}`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch project:', handleApiError(error));
      return null;
    }
  },

  /**
   * 获取所有项目（可按用户过滤）
   */
  async findAll(userId?: string): Promise<Project[]> {
    try {
      const params = userId ? { userId } : {};
      const response = await apiClient.get<Project[]>('/projects', { params });
      return response.data;
    } catch (error) {
      log.error('Failed to fetch projects:', handleApiError(error));
      return [];
    }
  },

  /**
   * 创建新项目
   */
  async create(data: CreateProjectInput): Promise<Project> {
    try {
      const response = await apiClient.post<Project>('/projects', data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create project: ${handleApiError(error)}`);
    }
  },

  /**
   * 更新项目
   */
  async update(id: string, data: UpdateProjectInput): Promise<Project> {
    try {
      const response = await apiClient.patch<Project>(`/projects/${id}`, data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to update project: ${handleApiError(error)}`);
    }
  },

  /**
   * 删除项目
   */
  async delete(id: string): Promise<void> {
    try {
      await apiClient.delete(`/projects/${id}`);
    } catch (error) {
      throw new Error(`Failed to delete project: ${handleApiError(error)}`);
    }
  },
};
