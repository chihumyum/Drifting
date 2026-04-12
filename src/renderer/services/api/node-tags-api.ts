/**
 * Node Tags API Service
 *
 * Backend contract:
 *   nodeTag: { id, projectId, name, createdAt, updatedAt }
 *   nodeTagLink: { nodeId, tagId }
 */

import apiClient from '../../lib/axios-config';

export interface CreateNodeTagDto {
  id: string;
  name: string;
}

export interface NodeTag {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export const nodeTagsApi = {
  // ---- Tag CRUD ----

  async list(projectId: string): Promise<NodeTag[]> {
    const response = await apiClient.get<NodeTag[]>(`/api/projects/${projectId}/node-tags`);
    return response.data;
  },

  async create(projectId: string, dto: CreateNodeTagDto): Promise<NodeTag> {
    const response = await apiClient.post<NodeTag>(`/api/projects/${projectId}/node-tags`, dto);
    return response.data;
  },

  async delete(projectId: string, tagId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/node-tags/${tagId}`);
  },

  // ---- Node-Tag Links ----

  async getTagsByNode(projectId: string, nodeId: string): Promise<NodeTag[]> {
    const response = await apiClient.get<NodeTag[]>(`/api/projects/${projectId}/node-tags/by-node/${nodeId}`);
    return response.data;
  },

  async addTagToNode(projectId: string, tagId: string, nodeId: string): Promise<void> {
    await apiClient.post(`/api/projects/${projectId}/node-tags/${tagId}/nodes/${nodeId}`);
  },

  async removeTagFromNode(projectId: string, tagId: string, nodeId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/node-tags/${tagId}/nodes/${nodeId}`);
  },

  async setNodeTags(projectId: string, nodeId: string, tagIds: string[]): Promise<void> {
    await apiClient.put(`/api/projects/${projectId}/node-tags/by-node/${nodeId}`, { tagIds });
  },
};
