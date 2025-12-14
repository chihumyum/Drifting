/**
 * Content API Service
 *
 * 调用后端 /api/projects/:projectId/contents 相关接口
 */

import apiClient from '../../lib/axios-config';

export interface RemoteContentItem {
  nodeId: string;
  pmJson: unknown;
  outline: string;
  contentText: string;
  wordCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListContentsResponse {
  items: RemoteContentItem[];
  nextCursor: number | null;
}

export const contentApi = {
  async list(projectId: string, options?: { updatedAfter?: number; cursor?: number; limit?: number }): Promise<ListContentsResponse> {
    const response = await apiClient.get<ListContentsResponse>(`/api/projects/${projectId}/contents`, {
      params: {
        ...(options?.updatedAfter ? { updatedAfter: options.updatedAfter } : {}),
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        ...(options?.limit ? { limit: options.limit } : {}),
      },
    });
    return response.data;
  },

  async getByNodeId(projectId: string, nodeId: string): Promise<RemoteContentItem> {
    const response = await apiClient.get<RemoteContentItem>(`/api/projects/${projectId}/contents/${nodeId}`);
    return response.data;
  },

  async upsert(
    projectId: string,
    nodeId: string,
    dto: { pmJson?: unknown; outline?: string; contentText?: string },
  ): Promise<RemoteContentItem> {
    const response = await apiClient.put<RemoteContentItem>(`/api/projects/${projectId}/contents/${nodeId}`, dto);
    return response.data;
  },
};
