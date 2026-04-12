/**
 * Content API Service
 *
 * Backend contract:
 *   nodeContent: { nodeId, contentJson, outlineJson, createdAt, updatedAt }
 *   Endpoints are under /api/projects/:projectId/nodes/:nodeId/content
 */

import apiClient from '../../lib/axios-config';

export interface RemoteContentItem {
  nodeId: string;
  contentJson: string;
  outlineJson: string;
  createdAt: string;
  updatedAt: string;
}

export const contentApi = {
  async getByNodeId(projectId: string, nodeId: string): Promise<RemoteContentItem> {
    const response = await apiClient.get<RemoteContentItem>(
      `/api/projects/${projectId}/nodes/${nodeId}/content`,
    );
    return response.data;
  },

  async upsert(
    projectId: string,
    nodeId: string,
    dto: { contentJson?: string; outlineJson?: string },
  ): Promise<RemoteContentItem> {
    const response = await apiClient.patch<RemoteContentItem>(
      `/api/projects/${projectId}/nodes/${nodeId}/content`,
      dto,
    );
    return response.data;
  },
};
