/**
 * Elements API Service
 *
 * 调用后端 /api/projects/:projectId/elements 相关接口
 */

import apiClient from '../../lib/axios-config';

// DTO 类型定义
export interface CreateElementDto {
  id?: string;
  name: string;
  categoryId?: string;
  categoryName?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateElementDto {
  name?: string;
  categoryId?: string;
  categoryName?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateCategoryDto {
  id?: string;
  name: string;
  color?: string;
}

export interface UpdateCategoryDto {
  name?: string;
  color?: string;
}

export interface EnsureCategoryDto {
  name: string;
}

export interface Element {
  id: string;
  projectId: string;
  name: string;
  categoryId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  isDeleted?: boolean;
}

export interface Category {
  id: string;
  projectId: string;
  name: string;
  descriptionJson?: Record<string, unknown> | null;
  color?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  isDeleted?: boolean;
}

export interface ListElementsResponse {
  items: Element[];
  nextCursor: string | null;
}

export interface ListCategoriesResponse {
  items: Category[];
  nextCursor: string | null;
}

/**
 * Elements API 客户端
 */
export const elementsApi = {
  /**
   * 获取项目的所有元素
   * GET /api/projects/:projectId/elements
   */
  async list(
    projectId: string,
    options?: { updatedAfter?: number; cursor?: string; limit?: number; includeDeleted?: boolean }
  ): Promise<ListElementsResponse> {
    const response = await apiClient.get<ListElementsResponse>(`/api/projects/${projectId}/elements`, {
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
   * 创建元素
   * POST /api/projects/:projectId/elements
   */
  async create(projectId: string, dto: CreateElementDto): Promise<Element> {
    const response = await apiClient.post<Element>(`/api/projects/${projectId}/elements`, dto);
    return response.data;
  },

  /**
   * 获取单个元素
   * GET /api/projects/:projectId/elements/:elementId
   */
  async getById(projectId: string, elementId: string): Promise<Element> {
    const response = await apiClient.get<Element>(`/api/projects/${projectId}/elements/${elementId}`);
    return response.data;
  },

  /**
   * 更新元素
   * PATCH /api/projects/:projectId/elements/:elementId
   */
  async update(projectId: string, elementId: string, dto: UpdateElementDto): Promise<Element> {
    const response = await apiClient.patch<Element>(`/api/projects/${projectId}/elements/${elementId}`, dto);
    return response.data;
  },

  /**
   * 删除元素
   * DELETE /api/projects/:projectId/elements/:elementId
   */
  async delete(projectId: string, elementId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/elements/${elementId}`);
  },

  // ==================== Categories ====================

  /**
   * 获取项目的所有分类
   * GET /api/projects/:projectId/elements/categories/list
   */
  async listCategories(
    projectId: string,
    options?: { updatedAfter?: number; cursor?: string; limit?: number; includeDeleted?: boolean }
  ): Promise<ListCategoriesResponse> {
    const response = await apiClient.get<ListCategoriesResponse>(`/api/projects/${projectId}/elements/categories/list`, {
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
   * 创建分类
   * POST /api/projects/:projectId/elements/categories
   */
  async createCategory(projectId: string, dto: CreateCategoryDto): Promise<Category> {
    const response = await apiClient.post<Category>(`/api/projects/${projectId}/elements/categories`, dto);
    return response.data;
  },

  /**
   * 更新分类
   * PATCH /api/projects/:projectId/elements/categories/:categoryId
   */
  async updateCategory(projectId: string, categoryId: string, dto: UpdateCategoryDto): Promise<Category> {
    const response = await apiClient.patch<Category>(`/api/projects/${projectId}/elements/categories/${categoryId}`, dto);
    return response.data;
  },

  /**
   * 删除分类
   * DELETE /api/projects/:projectId/elements/categories/:categoryId
   */
  async deleteCategory(projectId: string, categoryId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/elements/categories/${categoryId}`);
  },

  /**
   * 确保分类存在（如果不存在则创建）
   * POST /api/projects/:projectId/elements/categories/ensure
   */
  async ensureCategory(projectId: string, dto: EnsureCategoryDto): Promise<Category> {
    const response = await apiClient.post<Category>(`/api/projects/${projectId}/elements/categories/ensure`, dto);
    return response.data;
  },
};
