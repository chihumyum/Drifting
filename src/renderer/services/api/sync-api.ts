/**
 * Sync API Service
 * 
 * 调用后端 /api/projects/:projectId/sync 相关接口
 */

import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// 操作类型
export type OperationType = 'CREATE' | 'UPDATE' | 'DELETE';
export type EntityType = 'node' | 'storyline' | 'element' | 'category' | 'tag' | 'stage';

// 同步操作
export interface SyncOperation {
  id: string;
  entityType: EntityType;
  entityId: string;
  operationType: OperationType;
  data?: Record<string, unknown>;
  timestamp: number;
}

// DTO 类型定义
export interface PushOperationsDto {
  operations: SyncOperation[];
}

export interface SyncChangesQueryDto {
  since?: number;
}

export interface SyncResponse {
  operations: SyncOperation[];
}

/**
 * Sync API 客户端
 */
export const syncApi = {
  /**
   * 获取变更（拉取）
   * GET /api/projects/:projectId/sync/changes?since=timestamp
   */
  async getChanges(projectId: string, since?: number): Promise<SyncResponse> {
    const response = await axios.get(`${BASE_URL}/api/projects/${projectId}/sync/changes`, {
      params: { since },
    });
    return response.data;
  },

  /**
   * 推送变更
   * POST /api/projects/:projectId/sync/push
   */
  async pushChanges(projectId: string, operations: SyncOperation[]): Promise<SyncResponse> {
    const response = await axios.post(`${BASE_URL}/api/projects/${projectId}/sync/push`, {
      operations,
    });
    return response.data;
  },

  /**
   * 拉取变更（别名，调用 getChanges）
   * POST /api/projects/:projectId/sync/pull
   */
  async pullChanges(projectId: string, since?: number): Promise<SyncResponse> {
    const response = await axios.post(`${BASE_URL}/api/projects/${projectId}/sync/pull`, {
      since,
    });
    return response.data;
  },
};
