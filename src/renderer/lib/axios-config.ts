/**
 * Axios Configuration
 *
 * 配置 Axios 实例和拦截器
 * - 附带 trace id
 * - 基于 better-auth cookie 会话处理 401
 */

import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../store/auth';
import { getActiveTraceId } from './trace';

const BASE_URL =
  import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';

// 创建 Axios 实例
export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ==================== Request Interceptor ====================

apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    if (config.headers && !('x-trace-id' in config.headers)) {
      config.headers['x-trace-id'] = getActiveTraceId();
    }

    return config;
  },
  (error: AxiosError) => {
    return Promise.reject(error);
  },
);

// ==================== Response Interceptor ====================

apiClient.interceptors.response.use(
  (response) => {
    // 成功响应直接返回
    return response;
  },
  async (error: AxiosError) => {
    if (error.response?.status === 401) {
      try {
        const { isAuthenticated, logout } = useAuthStore.getState();
        if (isAuthenticated) {
          await logout();
          window.location.href = '/login';
        }
      } catch {
        // noop
      }
    }

    // 其他错误直接返回
    return Promise.reject(error);
  },
);

// 导出配置好的 axios 实例
export default apiClient;
