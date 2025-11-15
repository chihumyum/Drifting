import axios, { AxiosError } from 'axios';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import type { AuthStore } from '../store/auth';

// API 基础配置
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';
const TOKEN_STORAGE_KEY = 'drifting:access-token';

const getStorage = () => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const tokenManager = {
  setToken(token: string) {
    const storage = getStorage();
    if (storage) {
      storage.setItem(TOKEN_STORAGE_KEY, token);
    }
  },
  getToken(): string | null {
    const storage = getStorage();
    if (!storage) return null;
    return storage.getItem(TOKEN_STORAGE_KEY);
  },
  removeToken() {
    const storage = getStorage();
    if (storage) {
      storage.removeItem(TOKEN_STORAGE_KEY);
    }
  },
};

// 创建 axios 实例
export const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 动态导入 Auth Store（避免循环依赖）
let getAuthStore: (() => AuthStore) | null = null;

const loadAuthStore = async (): Promise<AuthStore> => {
  if (!getAuthStore) {
    const module = await import('../store/auth');
    getAuthStore = () => module.useAuthStore.getState();
  }
  return getAuthStore();
};

// 请求拦截器：添加 JWT token
apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    try {
      const authStore = await loadAuthStore();
      const token = authStore.accessToken;
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch (error) {
      console.error('[API] Failed to get auth token:', error);
    }
    return config;
  },
  (error: AxiosError) => {
    return Promise.reject(error);
  }
);

// 响应拦截器：处理通用错误和 Token 刷新
apiClient.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    
    // 401 错误：Token 过期，尝试刷新
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const authStore = await loadAuthStore();
        const refreshToken = authStore.refreshToken;
        
        if (!refreshToken) {
          throw new Error('No refresh token available');
        }

        // 动态导入 auth API（避免循环依赖）
        const { authApi } = await import('../services/api/auth-api');
        
        // 刷新 Token
        const { accessToken: newAccessToken } = await authApi.refreshToken({
          refreshToken,
        });

        // 更新 Store
        authStore.setAccessToken(newAccessToken);

        // 重试原请求
        if (originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        }
        return apiClient(originalRequest);
      } catch (refreshError) {
        // 刷新失败，清除登录状态并重定向到登录页
        const authStore = await loadAuthStore();
        authStore.logout();
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    // 403 错误：权限不足
    if (error.response?.status === 403) {
      console.error('[API] Permission denied:', error.response.data);
    }

    // 500 错误：服务器错误
    if (error.response?.status === 500) {
      console.error('[API] Server error:', error.response.data);
    }

    return Promise.reject(error);
  }
);

// API 错误处理工具
export const handleApiError = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<{ message?: string; error?: string }>;
    
    if (axiosError.response?.data?.message) {
      return axiosError.response.data.message;
    }
    
    if (axiosError.response?.data?.error) {
      return axiosError.response.data.error;
    }
    
    if (axiosError.message) {
      return axiosError.message;
    }
  }
  
  if (error instanceof Error) {
    return error.message;
  }
  
  return 'An unknown error occurred';
};

// 导出 API 客户端
export default apiClient;
