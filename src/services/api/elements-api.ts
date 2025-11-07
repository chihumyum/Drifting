/**
 * Elements API Service
 * 
 * 调用后端 /api/projects/:projectId/elements 相关接口
 */

import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// DTO 类型定义
export interface CreateElementDto {
  name: string;
  categoryId: string;
  description?: string;
  attributes?: Record<string, unknown>;
  imageUrl?: string;
}

export interface UpdateElementDto {
  name?: string;
  categoryId?: string;
  description?: string;
  attributes?: Record<string, unknown>;
  imageUrl?: string;
}

export interface CreateCategoryDto {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
}

export interface UpdateCategoryDto {
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
}

export interface EnsureCategoryDto {
  name: string;
}

export interface Element {
  id: string;
  projectId: string;
  name: string;
  categoryId: string;
  description?: string;
  attributes?: Record<string, unknown>;
  imageUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Elements API 客户端
 */
export const elementsApi = {
  /**
   * 获取项目的所有元素
   * GET /api/projects/:projectId/elements
   */
  async getAll(projectId: string): Promise<Element[]> {
    const response = await axios.get(`${BASE_URL}/api/projects/${projectId}/elements`);
    return response.data;
  },

  /**
   * 创建元素
   * POST /api/projects/:projectId/elements
   */
  async create(projectId: string, dto: CreateElementDto): Promise<Element> {
    const response = await axios.post(`${BASE_URL}/api/projects/${projectId}/elements`, dto);
    return response.data;
  },

  /**
   * 获取单个元素
   * GET /api/projects/:projectId/elements/:elementId
   */
  async getById(projectId: string, elementId: string): Promise<Element> {
    const response = await axios.get(`${BASE_URL}/api/projects/${projectId}/elements/${elementId}`);
    return response.data;
  },

  /**
   * 更新元素
   * PATCH /api/projects/:projectId/elements/:elementId
   */
  async update(projectId: string, elementId: string, dto: UpdateElementDto): Promise<Element> {
    const response = await axios.patch(`${BASE_URL}/api/projects/${projectId}/elements/${elementId}`, dto);
    return response.data;
  },

  /**
   * 删除元素
   * DELETE /api/projects/:projectId/elements/:elementId
   */
  async delete(projectId: string, elementId: string): Promise<void> {
    await axios.delete(`${BASE_URL}/api/projects/${projectId}/elements/${elementId}`);
  },

  // ==================== Categories ====================

  /**
   * 获取项目的所有分类
   * GET /api/projects/:projectId/elements/categories/list
   */
  async listCategories(projectId: string): Promise<Category[]> {
    const response = await axios.get(`${BASE_URL}/api/projects/${projectId}/elements/categories/list`);
    return response.data;
  },

  /**
   * 创建分类
   * POST /api/projects/:projectId/elements/categories
   */
  async createCategory(projectId: string, dto: CreateCategoryDto): Promise<Category> {
    const response = await axios.post(`${BASE_URL}/api/projects/${projectId}/elements/categories`, dto);
    return response.data;
  },

  /**
   * 更新分类
   * PATCH /api/projects/:projectId/elements/categories/:categoryId
   */
  async updateCategory(projectId: string, categoryId: string, dto: UpdateCategoryDto): Promise<Category> {
    const response = await axios.patch(`${BASE_URL}/api/projects/${projectId}/elements/categories/${categoryId}`, dto);
    return response.data;
  },

  /**
   * 删除分类
   * DELETE /api/projects/:projectId/elements/categories/:categoryId
   */
  async deleteCategory(projectId: string, categoryId: string): Promise<void> {
    await axios.delete(`${BASE_URL}/api/projects/${projectId}/elements/categories/${categoryId}`);
  },

  /**
   * 确保分类存在（如果不存在则创建）
   * POST /api/projects/:projectId/elements/categories/ensure
   */
  async ensureCategory(projectId: string, dto: EnsureCategoryDto): Promise<Category> {
    const response = await axios.post(`${BASE_URL}/api/projects/${projectId}/elements/categories/ensure`, dto);
    return response.data;
  },
};
