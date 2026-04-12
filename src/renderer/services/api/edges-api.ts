/**
 * Edges API Service
 *
 * Backend contract:
 *   nodeEdge: { id, projectId, sourceNodeId, targetNodeId, label, weight, isDirected, styleJson, controlPointOffsetJson, sourceAnchorJson, targetAnchorJson, createdAt, updatedAt }
 */

import apiClient from '../../lib/axios-config';

export interface CreateEdgeDto {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  weight?: number;
  isDirected?: boolean;
  styleJson?: string;
  controlPointOffsetJson?: string;
  sourceAnchorJson?: string;
  targetAnchorJson?: string;
}

export interface UpdateEdgeDto {
  label?: string;
  weight?: number;
  isDirected?: boolean;
  styleJson?: string;
  controlPointOffsetJson?: string;
  sourceAnchorJson?: string;
  targetAnchorJson?: string;
}

export interface Edge {
  id: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string;
  weight: number;
  isDirected: boolean;
  styleJson: string | null;
  controlPointOffsetJson: string | null;
  sourceAnchorJson: string | null;
  targetAnchorJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export const edgesApi = {
  async list(projectId: string): Promise<Edge[]> {
    const response = await apiClient.get<Edge[]>(`/api/projects/${projectId}/edges`);
    return response.data;
  },

  async create(projectId: string, dto: CreateEdgeDto): Promise<Edge> {
    const response = await apiClient.post<Edge>(`/api/projects/${projectId}/edges`, dto);
    return response.data;
  },

  async update(projectId: string, edgeId: string, dto: UpdateEdgeDto): Promise<Edge> {
    const response = await apiClient.patch<Edge>(`/api/projects/${projectId}/edges/${edgeId}`, dto);
    return response.data;
  },

  async delete(projectId: string, edgeId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/edges/${edgeId}`);
  },
};
