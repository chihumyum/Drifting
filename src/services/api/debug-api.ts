/**
 * Debug API Service
 * 
 * 用于获取服务器端和 SQLite 端的所有用户数据
 */

import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

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
    const response = await axios.get(`${BASE_URL}/api/debug/my-data`);
    return response.data;
  },
};
