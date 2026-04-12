/**
 * Node API Service
 *
 * Backend contract:
 *   bookNode: { id, projectId, mainStorylineId, title, summary, start, end, positionX, positionY, storyStageId, createdAt, updatedAt }
 *   nodeContent: { nodeId, contentJson, outlineJson, createdAt, updatedAt }
 *   nodeEdge: { id, projectId, sourceNodeId, targetNodeId, label, weight, isDirected, styleJson, ... }
 */

import apiClient from '../../lib/axios-config';
import type { BookNode } from '../../domain/book-node';

/** Raw node shape from server */
interface ServerNode {
  id: string;
  projectId: string;
  mainStorylineId: string;
  title: string;
  summary: string;
  start: number;
  end: number;
  positionX: number;
  positionY: number;
  storyStageId: string | null;
  createdAt: string;
  updatedAt: string;
}

const toBookNode = (node: ServerNode): BookNode => ({
  id: node.id,
  projectId: node.projectId,
  title: node.title,
  start: node.start ?? 0,
  end: node.end ?? 0,
  summary: node.summary ?? '',
  storyStageId: node.storyStageId ?? null,
  mainStorylineId: node.mainStorylineId ?? '',
  position: {
    x: node.positionX ?? 0,
    y: node.positionY ?? 0,
  },
  createdAt: new Date(node.createdAt).toISOString(),
  updatedAt: new Date(node.updatedAt).toISOString(),
  storylineIds: [],
  tagIds: [],
});

export interface CreateNodeDto {
  id: string;
  title: string;
  start: number;
  end?: number;
  summary?: string;
  storyStageId?: string | null;
  mainStorylineId: string;
  positionX?: number;
  positionY?: number;
}

export interface UpdateNodeDto {
  title?: string;
  start?: number;
  end?: number;
  summary?: string;
  storyStageId?: string | null;
  mainStorylineId?: string;
  positionX?: number;
  positionY?: number;
}

export interface UpdateNodeContentDto {
  contentJson?: string;
  outlineJson?: string;
}

export const nodeApi = {
  /** Backend returns flat array (no pagination) */
  async getAll(projectId: string): Promise<BookNode[]> {
    const response = await apiClient.get<ServerNode[]>(`/api/projects/${projectId}/nodes`);
    return response.data.map(toBookNode);
  },

  async create(projectId: string, dto: CreateNodeDto): Promise<BookNode> {
    const response = await apiClient.post<ServerNode>(`/api/projects/${projectId}/nodes`, dto);
    return toBookNode(response.data);
  },

  async getById(projectId: string, nodeId: string): Promise<BookNode> {
    const response = await apiClient.get<ServerNode>(`/api/projects/${projectId}/nodes/${nodeId}`);
    return toBookNode(response.data);
  },

  async update(projectId: string, nodeId: string, dto: UpdateNodeDto): Promise<BookNode> {
    const response = await apiClient.patch<ServerNode>(`/api/projects/${projectId}/nodes/${nodeId}`, dto);
    return toBookNode(response.data);
  },

  async delete(projectId: string, nodeId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/nodes/${nodeId}`);
  },

  async getContent(projectId: string, nodeId: string): Promise<unknown> {
    const response = await apiClient.get(`/api/projects/${projectId}/nodes/${nodeId}/content`);
    return response.data;
  },

  async updateContent(projectId: string, nodeId: string, dto: UpdateNodeContentDto): Promise<unknown> {
    const response = await apiClient.patch(`/api/projects/${projectId}/nodes/${nodeId}/content`, dto);
    return response.data;
  },

  async swapOrder(projectId: string, first: { id: string; order: number }, second: { id: string; order: number }): Promise<void> {
    await apiClient.post(`/api/projects/${projectId}/nodes/swap-order`, { first, second });
  },

  async setStorylines(projectId: string, nodeId: string, storylineIds: string[]): Promise<void> {
    await apiClient.put(`/api/projects/${projectId}/nodes/${nodeId}/storylines`, { storylineIds });
  },
};
