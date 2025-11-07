/**
 * Node API Service
 * 
 * 调用后端 /api/projects/:projectId/nodes 相关接口
 */

import axios from 'axios';
import type { BookNode } from '../../domain/book_node';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// DTO 类型定义（与后端对齐）
export interface CreateNodeDto {
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
  async getAll(projectId: string): Promise<BookNode[]> {
    const response = await axios.get(`${BASE_URL}/api/projects/${projectId}/nodes`);
    return response.data;
  },

  /**
   * 创建节点
   * POST /api/projects/:projectId/nodes
   */
  async create(projectId: string, dto: CreateNodeDto): Promise<BookNode> {
    const response = await axios.post(`${BASE_URL}/api/projects/${projectId}/nodes`, dto);
    return response.data;
  },

  /**
   * 获取单个节点
   * GET /api/projects/:projectId/nodes/:nodeId
   */
  async getById(projectId: string, nodeId: string): Promise<BookNode> {
    const response = await axios.get(`${BASE_URL}/api/projects/${projectId}/nodes/${nodeId}`);
    return response.data;
  },

  /**
   * 更新节点
   * PATCH /api/projects/:projectId/nodes/:nodeId
   */
  async update(projectId: string, nodeId: string, dto: UpdateNodeDto): Promise<BookNode> {
    const response = await axios.patch(`${BASE_URL}/api/projects/${projectId}/nodes/${nodeId}`, dto);
    return response.data;
  },

  /**
   * 删除节点
   * DELETE /api/projects/:projectId/nodes/:nodeId
   */
  async delete(projectId: string, nodeId: string): Promise<void> {
    await axios.delete(`${BASE_URL}/api/projects/${projectId}/nodes/${nodeId}`);
  },

  /**
   * 获取节点内容
   * GET /api/projects/:projectId/nodes/:nodeId/content
   */
  async getContent(projectId: string, nodeId: string): Promise<unknown> {
    const response = await axios.get(`${BASE_URL}/api/projects/${projectId}/nodes/${nodeId}/content`);
    return response.data;
  },

  /**
   * 更新节点内容
   * PUT /api/projects/:projectId/nodes/:nodeId/content
   */
  async updateContent(projectId: string, nodeId: string, dto: UpdateNodeContentDto): Promise<unknown> {
    const response = await axios.put(`${BASE_URL}/api/projects/${projectId}/nodes/${nodeId}/content`, dto);
    return response.data;
  },
};
