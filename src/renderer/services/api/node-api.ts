/**
 * Node API Service
 * 
 * 调用后端 /api/projects/:projectId/nodes 相关接口
 */

import apiClient from '../../lib/axios-config';
import type { BookNode } from '../../domain/book-node';

interface NodeResponse {
  id: string;
  projectId: string;
  title: string;
  summary?: string | null;
  start?: number | null;
  end?: number | null;
  posX?: number | null;
  posY?: number | null;
  storyStageId?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListNodesResponse {
  items: NodeResponse[];
  nextCursor: string | null;
}

const toBookNode = (node: NodeResponse): BookNode => ({
  id: node.id,
  projectId: node.projectId,
  title: node.title,
  start: node.start ?? 0,
  end: node.end ?? 0,
  summary: node.summary ?? '',
  storyStageId: node.storyStageId ?? '',
  position: {
    x: node.posX ?? 0,
    y: node.posY ?? 0,
  },
  createdAt: new Date(node.createdAt).toISOString(),
  updatedAt: new Date(node.updatedAt).toISOString(),
  storylineIds: [], // Not returned by API list
  tagIds: [], // Not returned by API list
});

// DTO 类型定义（与后端对齐）
export interface CreateNodeDto {
  id?: string;
  title: string;
  start: number;
  end?: number;
  summary?: string;
  storyStageId?: string;
  posX?: number;
  posY?: number;
}

export interface UpdateNodeDto {
  title?: string;
  start?: number;
  end?: number;
  summary?: string;
  storyStageId?: string;
  posX?: number;
  posY?: number;
}

export interface BulkCreateNodesDto {
  nodes: CreateNodeDto[];
}

export interface UpdateNodeContentDto {
  pmJson?: unknown;
  outline?: string;
  wordCount?: number;
  contentText?: string;
}

export const nodeApi = {
  /**
   * 获取项目的所有节点
   * GET /api/projects/:projectId/nodes
   */
  async getAll(projectId: string, options?: { updatedAfter?: number }): Promise<BookNode[]> {
    const items: BookNode[] = [];
    let cursor: string | undefined;

    // page through results (backend returns {items,nextCursor})
    // keep page size conservative to avoid large payloads
    for (let i = 0; i < 20; i++) {
      const response = await apiClient.get<ListNodesResponse>(`/api/projects/${projectId}/nodes`, {
        params: {
          ...(options?.updatedAfter ? { updatedAfter: options.updatedAfter } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 500,
          includeDeleted: true,
        },
      });

      const page = response.data.items.map(toBookNode);
      items.push(...page);

      if (!response.data.nextCursor) break;
      cursor = response.data.nextCursor;
    }

    return items;
  },

  /**
   * 创建节点
   * POST /api/projects/:projectId/nodes
   */
  async create(projectId: string, dto: CreateNodeDto): Promise<BookNode> {
    const response = await apiClient.post<NodeResponse>(`/api/projects/${projectId}/nodes`, dto);
    return toBookNode(response.data);
  },

  /**
   * 获取单个节点
   * GET /api/projects/:projectId/nodes/:nodeId
   */
  async getById(projectId: string, nodeId: string): Promise<BookNode> {
    const response = await apiClient.get<NodeResponse>(`/api/projects/${projectId}/nodes/${nodeId}`);
    return toBookNode(response.data);
  },

  /**
   * 更新节点
   * PATCH /api/projects/:projectId/nodes/:nodeId
   */
  async update(projectId: string, nodeId: string, dto: UpdateNodeDto): Promise<BookNode> {
    const response = await apiClient.patch<NodeResponse>(`/api/projects/${projectId}/nodes/${nodeId}`, dto);
    return toBookNode(response.data);
  },

  /**
   * 删除节点
   * DELETE /api/projects/:projectId/nodes/:nodeId
   */
  async delete(projectId: string, nodeId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/nodes/${nodeId}`);
  },

  /**
   * 获取节点内容
   * GET /api/projects/:projectId/nodes/:nodeId/content
   */
  async getContent(projectId: string, nodeId: string): Promise<unknown> {
    const response = await apiClient.get(`/api/projects/${projectId}/nodes/${nodeId}/content`);
    return response.data;
  },

  /**
   * 更新节点内容
   * PUT /api/projects/:projectId/nodes/:nodeId/content
   */
  async updateContent(projectId: string, nodeId: string, dto: UpdateNodeContentDto): Promise<unknown> {
    const response = await apiClient.put(`/api/projects/${projectId}/nodes/${nodeId}/content`, dto);
    return response.data;
  },
};
