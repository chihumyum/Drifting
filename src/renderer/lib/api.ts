import axios, { AxiosError } from 'axios';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { getActiveTraceId } from './trace';
import loglevel from "loglevel";

const log = loglevel.getLogger("ApiLib");
log.setLevel(loglevel.levels.ERROR);

// API 基础配置
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_URL ||
  'http://localhost:3000';

// 创建 axios 实例
export const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // better-auth 需要发送 cookies
});

// 请求拦截器：添加 trace ID
apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    if (config.headers && !('x-trace-id' in config.headers)) {
      config.headers['x-trace-id'] = getActiveTraceId();
    }
    return config;
  },
  (error: AxiosError) => {
    return Promise.reject(error);
  }
);

// 响应拦截器：处理通用错误
apiClient.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error: AxiosError) => {
    // 401 错误：未认证，清除本地状态
    if (error.response?.status === 401) {
      log.error('[API] Unauthorized - session may have expired');
      
      // 动态导入 auth store 避免循环依赖
      try {
        const { useAuthStore } = await import('../store/auth');
        const authStore = useAuthStore.getState();
        
        // 只在当前认为已登录时才登出
        if (authStore.isAuthenticated) {
          await authStore.logout();
          window.location.href = '/login';
        }
      } catch (importError) {
        log.error('[API] Failed to handle 401:', importError);
      }
    }

    // 403 错误：权限不足
    if (error.response?.status === 403) {
      log.error('[API] Permission denied:', error.response.data);
    }

    // 500 错误：服务器错误
    if (error.response?.status === 500) {
      log.error('[API] Server error:', error.response.data);
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
