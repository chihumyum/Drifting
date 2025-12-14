/**
 * Axios Configuration
 * 
 * 配置 Axios 实例和拦截器
 * - 自动添加 JWT Token
 * - 401 自动刷新 Token
 * - 统一错误处理
 */

import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../store/auth';
import { authApi } from '../services/api/auth-api';
import { getActiveTraceId } from './trace';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// 创建 Axios 实例
export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 是否正在刷新 Token
let isRefreshing = false;
// 等待刷新的请求队列
let failedQueue: Array<{
  resolve: (value?: unknown) => void;
  reject: (error?: unknown) => void;
}> = [];

// 处理队列中的请求
const processQueue = (error: Error | null, token: string | null = null) => {
  failedQueue.forEach((promise) => {
    if (error) {
      promise.reject(error);
    } else {
      promise.resolve(token);
    }
  });
  
  failedQueue = [];
};

// ==================== Request Interceptor ====================

apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    if (config.headers && !('x-trace-id' in config.headers)) {
      config.headers['x-trace-id'] = getActiveTraceId();
    }

    // 获取 accessToken
    const { accessToken } = useAuthStore.getState();
    
    // 如果有 token 且不是刷新请求，则添加到 header
    if (accessToken && !config.url?.includes('/auth/refresh')) {
      config.headers.Authorization = `Bearer ${accessToken}`;
    }
    
    return config;
  },
  (error: AxiosError) => {
    return Promise.reject(error);
  }
);

// ==================== Response Interceptor ====================

apiClient.interceptors.response.use(
  (response) => {
    // 成功响应直接返回
    return response;
  },
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    
    // 如果是 401 错误且不是刷新请求
    if (error.response?.status === 401 && !originalRequest._retry) {
      // 如果正在刷新，将请求加入队列
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${token}`;
            }
            return apiClient(originalRequest);
          })
          .catch((err) => {
            return Promise.reject(err);
          });
      }
      
      originalRequest._retry = true;
      isRefreshing = true;
      
      const { refreshToken, setAccessToken, logout } = useAuthStore.getState();
      
      // 如果没有 refreshToken，直接登出
      if (!refreshToken) {
        logout();
        processQueue(new Error('No refresh token'), null);
        return Promise.reject(error);
      }
      
      try {
        // 调用刷新接口
        const response = await authApi.refreshToken({ refreshToken });
        const newAccessToken = response.accessToken;
        
        // 更新 Store 中的 Token
        setAccessToken(newAccessToken);
        
        // 更新原始请求的 header
        if (originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        }
        
        // 处理队列中的请求
        processQueue(null, newAccessToken);
        
        // 重试原始请求
        return apiClient(originalRequest);
      } catch (refreshError) {
        // 刷新失败，登出用户
        processQueue(refreshError as Error, null);
        logout();
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }
    
    // 其他错误直接返回
    return Promise.reject(error);
  }
);

// 导出配置好的 axios 实例
export default apiClient;
