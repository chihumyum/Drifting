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
import { getDeviceId } from './device-id';
import { getSessionToken } from './session-token';

const BASE_URL =
  import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';

// 创建 Axios 实例
export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  // Bearer auth — the session rides the Authorization header (set below), not a
  // cookie. Sending cookies would re-trigger better-auth's origin/CSRF check.
  withCredentials: false,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ==================== Request Interceptor ====================

apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getSessionToken();
    if (token && config.headers) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    if (config.headers && !('x-trace-id' in config.headers)) {
      config.headers['x-trace-id'] = getActiveTraceId();
    }
    if (config.headers && !('x-device-id' in config.headers)) {
      config.headers['x-device-id'] = getDeviceId();
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
        const { expireSession } = useAuthStore.getState();
        if (getSessionToken()) {
          await expireSession();
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
