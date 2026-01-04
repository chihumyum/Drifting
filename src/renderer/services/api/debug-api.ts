/**
 * Debug API Service
 * 
 * 用于获取服务器端和 SQLite 端的所有用户数据
 */

import { apiClient } from '../../lib/axios-config';

export interface DebugData {
  serverData: {
    user: unknown;
    projects: unknown[];
    nodes: unknown[];
    threads: unknown[];
    elements: unknown[];
    categories: unknown[];
  };
}

/**
 * Debug API 客户端
 */
export const debugApi = {
  /**
   * 获取服务器端当前用户的所有数据
   * GET /api/debug/my-data
   */
  async getServerData(): Promise<DebugData['serverData']> {
    const response = await apiClient.get('/api/debug/my-data');
    return response.data;
  },
};
