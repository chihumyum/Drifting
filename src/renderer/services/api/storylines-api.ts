/**
 * Storylines API Service
 *
 * Backend contract:
 *   storyline: { id, projectId, name, color, summary, orderKey, descriptionJson, createdAt, updatedAt }
 *   nodeStorylineLink: { nodeId, storylineId }
 */

import apiClient from '../../lib/axios-config';

export interface CreateStorylineDto {
  id: string;
  name: string;
  color: string;
  summary?: string;
  orderKey: number;
  descriptionJson?: string;
}

export interface UpdateStorylineDto {
  name?: string;
  color?: string;
  summary?: string;
  orderKey?: number;
  descriptionJson?: string;
}

export interface Storyline {
  id: string;
  projectId: string;
  name: string;
  color: string;
  summary: string;
  orderKey: number;
  descriptionJson: string;
  createdAt: string;
  updatedAt: string;
}

export const storylinesApi = {
  /** Backend returns flat array (no pagination) */
  async list(projectId: string): Promise<Storyline[]> {
    const response = await apiClient.get<Storyline[]>(`/api/projects/${projectId}/storylines`);
    return response.data;
  },

  async create(projectId: string, dto: CreateStorylineDto): Promise<Storyline> {
    const response = await apiClient.post<Storyline>(`/api/projects/${projectId}/storylines`, dto);
    return response.data;
  },

  async update(projectId: string, storylineId: string, dto: UpdateStorylineDto): Promise<Storyline> {
    const response = await apiClient.patch<Storyline>(`/api/projects/${projectId}/storylines/${storylineId}`, dto);
    return response.data;
  },

  async delete(projectId: string, storylineId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/storylines/${storylineId}`);
  },

  // ---- Node-Storyline relationships ----

  async getNodesByStoryline(projectId: string, storylineId: string): Promise<string[]> {
    const response = await apiClient.get<string[]>(`/api/projects/${projectId}/storylines/${storylineId}/nodes`);
    return response.data;
  },

  async addNodeToStoryline(projectId: string, storylineId: string, nodeId: string): Promise<void> {
    await apiClient.post(`/api/projects/${projectId}/storylines/${storylineId}/nodes/${nodeId}`);
  },

  async removeNodeFromStoryline(projectId: string, storylineId: string, nodeId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/storylines/${storylineId}/nodes/${nodeId}`);
  },

  async getStorylinesByNode(projectId: string, nodeId: string): Promise<Storyline[]> {
    const response = await apiClient.get<Storyline[]>(`/api/projects/${projectId}/storylines/by-node/${nodeId}`);
    return response.data;
  },
};
