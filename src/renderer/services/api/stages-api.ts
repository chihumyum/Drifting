/**
 * Story Stages API Service
 *
 * Backend contract:
 *   storyStage: { id, projectId, name, descriptionJson, orderKey, color, createdAt, updatedAt }
 */

import apiClient from '../../lib/axios-config';

export interface CreateStageDto {
  id: string;
  name: string;
  color: string;
  orderKey: number;
  descriptionJson?: string;
}

export interface UpdateStageDto {
  name?: string;
  color?: string;
  orderKey?: number;
  descriptionJson?: string;
}

export interface StoryStage {
  id: string;
  projectId: string;
  name: string;
  descriptionJson: string;
  orderKey: number;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export const stagesApi = {
  async list(projectId: string): Promise<StoryStage[]> {
    const response = await apiClient.get<StoryStage[]>(`/api/projects/${projectId}/stages`);
    return response.data;
  },

  async create(projectId: string, dto: CreateStageDto): Promise<StoryStage> {
    const response = await apiClient.post<StoryStage>(`/api/projects/${projectId}/stages`, dto);
    return response.data;
  },

  async update(projectId: string, stageId: string, dto: UpdateStageDto): Promise<StoryStage> {
    const response = await apiClient.patch<StoryStage>(`/api/projects/${projectId}/stages/${stageId}`, dto);
    return response.data;
  },

  async delete(projectId: string, stageId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/stages/${stageId}`);
  },
};
