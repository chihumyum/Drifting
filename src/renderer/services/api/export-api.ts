/**
 * Export API Service
 *
 * 调用后端 /api/projects/:projectId/export 相关接口
 */

import axios from 'axios';

const BASE_URL =
  import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';

// DTO 类型定义
export interface CreateExportDto {
  format: 'pdf' | 'markdown' | 'docx' | 'epub';
  includeElements?: boolean;
  includeStorylines?: boolean;
  customTemplate?: string;
}

export interface ExportHistoryEntry {
  id: string;
  projectId: string;
  format: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  downloadUrl?: string;
  createdAt: string;
  completedAt?: string;
}

/**
 * Export API 客户端
 */
export const exportApi = {
  /**
   * 创建导出任务
   * POST /api/projects/:projectId/export
   */
  async create(projectId: string, dto: CreateExportDto): Promise<ExportHistoryEntry> {
    const response = await axios.post(`${BASE_URL}/api/projects/${projectId}/export`, dto);
    return response.data;
  },

  /**
   * 获取导出历史
   * GET /api/projects/:projectId/exports
   */
  async getAll(projectId: string): Promise<ExportHistoryEntry[]> {
    const response = await axios.get(`${BASE_URL}/api/projects/${projectId}/exports`);
    return response.data;
  },
};
