/**
 * Elements API Service
 *
 * Backend contract:
 *   bookElement: { id, projectId, categoryId, name, summary, contentJson, createdAt, updatedAt }
 *   elementCategory: { id, projectId, name, descriptionJson, color, createdAt, updatedAt }
 *   elementStage: { id, elementId, stageName, summary, contentJson, orderKey, startNodeId, endNodeId, ... }
 *   elementTag: { id, projectId, name, createdAt, updatedAt }
 *   elementTagLink: { elementId, tagId }
 */

import apiClient from '../../lib/axios-config';

// ==================== Element DTOs ====================

export interface CreateElementDto {
  id: string;
  name: string;
  categoryId: string;
  summary?: string;
  contentJson?: string;
}

export interface UpdateElementDto {
  name?: string;
  categoryId?: string;
  summary?: string;
  contentJson?: string;
}

export interface Element {
  id: string;
  projectId: string;
  categoryId: string;
  name: string;
  summary: string;
  contentJson: string;
  createdAt: string;
  updatedAt: string;
}

// ==================== Category DTOs ====================

export interface CreateCategoryDto {
  id: string;
  name: string;
  color: string;
  descriptionJson?: string;
}

export interface UpdateCategoryDto {
  name?: string;
  color?: string;
  descriptionJson?: string;
}

export interface Category {
  id: string;
  projectId: string;
  name: string;
  descriptionJson: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

// ==================== Element Stage DTOs ====================

export interface CreateElementStageDto {
  id: string;
  stageName: string;
  summary?: string;
  contentJson?: string;
  orderKey: number;
  startNodeId?: string | null;
  endNodeId?: string | null;
}

export interface UpdateElementStageDto {
  stageName?: string;
  summary?: string;
  contentJson?: string;
  orderKey?: number;
  startNodeId?: string | null;
  endNodeId?: string | null;
}

export interface ElementStage {
  id: string;
  elementId: string;
  stageName: string;
  summary: string;
  contentJson: string;
  orderKey: number;
  startNodeId: string | null;
  endNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ==================== Element Tag DTOs ====================

export interface ElementTag {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateElementTagDto {
  id: string;
  name: string;
}

export const elementsApi = {
  // ==================== Elements ====================

  /** Backend returns flat array */
  async list(projectId: string): Promise<Element[]> {
    const response = await apiClient.get<Element[]>(`/api/projects/${projectId}/elements`);
    return response.data;
  },

  async create(projectId: string, dto: CreateElementDto): Promise<Element> {
    const response = await apiClient.post<Element>(`/api/projects/${projectId}/elements`, dto);
    return response.data;
  },

  async getById(projectId: string, elementId: string): Promise<Element> {
    const response = await apiClient.get<Element>(`/api/projects/${projectId}/elements/${elementId}`);
    return response.data;
  },

  async update(projectId: string, elementId: string, dto: UpdateElementDto): Promise<Element> {
    const response = await apiClient.patch<Element>(`/api/projects/${projectId}/elements/${elementId}`, dto);
    return response.data;
  },

  async delete(projectId: string, elementId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/elements/${elementId}`);
  },

  // ==================== Categories (under /categories, NOT /elements/categories) ====================

  async listCategories(projectId: string): Promise<Category[]> {
    const response = await apiClient.get<Category[]>(`/api/projects/${projectId}/categories`);
    return response.data;
  },

  async createCategory(projectId: string, dto: CreateCategoryDto): Promise<Category> {
    const response = await apiClient.post<Category>(`/api/projects/${projectId}/categories`, dto);
    return response.data;
  },

  async updateCategory(projectId: string, categoryId: string, dto: UpdateCategoryDto): Promise<Category> {
    const response = await apiClient.patch<Category>(`/api/projects/${projectId}/categories/${categoryId}`, dto);
    return response.data;
  },

  async deleteCategory(projectId: string, categoryId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/categories/${categoryId}`);
  },

  // ==================== Element Tags ====================

  async listTags(projectId: string): Promise<ElementTag[]> {
    const response = await apiClient.get<ElementTag[]>(`/api/projects/${projectId}/element-tags`);
    return response.data;
  },

  async createTag(projectId: string, dto: CreateElementTagDto): Promise<ElementTag> {
    const response = await apiClient.post<ElementTag>(`/api/projects/${projectId}/element-tags`, dto);
    return response.data;
  },

  async deleteTag(projectId: string, tagId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/element-tags/${tagId}`);
  },

  // ==================== Element-Tag Links ====================

  async getElementTags(projectId: string, elementId: string): Promise<string[]> {
    const response = await apiClient.get<string[]>(`/api/projects/${projectId}/elements/${elementId}/tags`);
    return response.data;
  },

  async addTagToElement(projectId: string, elementId: string, tagId: string): Promise<void> {
    await apiClient.post(`/api/projects/${projectId}/elements/${elementId}/tags/${tagId}`);
  },

  async removeTagFromElement(projectId: string, elementId: string, tagId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/elements/${elementId}/tags/${tagId}`);
  },

  async setElementTags(projectId: string, elementId: string, tagIds: string[]): Promise<void> {
    await apiClient.put(`/api/projects/${projectId}/elements/${elementId}/tags`, { tagIds });
  },

  // ==================== Element Stages ====================

  async listStages(projectId: string, elementId: string): Promise<ElementStage[]> {
    const response = await apiClient.get<ElementStage[]>(`/api/projects/${projectId}/elements/${elementId}/stages`);
    return response.data;
  },

  async createStage(projectId: string, elementId: string, dto: CreateElementStageDto): Promise<ElementStage> {
    const response = await apiClient.post<ElementStage>(`/api/projects/${projectId}/elements/${elementId}/stages`, dto);
    return response.data;
  },

  async updateStage(projectId: string, elementId: string, stageId: string, dto: UpdateElementStageDto): Promise<ElementStage> {
    const response = await apiClient.patch<ElementStage>(`/api/projects/${projectId}/elements/${elementId}/stages/${stageId}`, dto);
    return response.data;
  },

  async deleteStage(projectId: string, elementId: string, stageId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/elements/${elementId}/stages/${stageId}`);
  },
};
