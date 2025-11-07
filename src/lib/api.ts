import axios, { AxiosError } from 'axios';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';

// API 基础配置
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

// 创建 axios 实例
export const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Token 管理
export const tokenManager = {
  getToken: (): string | null => {
    return localStorage.getItem('accessToken');
  },
  setToken: (token: string) => {
    localStorage.setItem('accessToken', token);
  },
  removeToken: () => {
    localStorage.removeItem('accessToken');
  },
};

// 请求拦截器：添加 JWT token
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = tokenManager.getToken();
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
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
    // 401 错误：token 过期或无效
    if (error.response?.status === 401) {
      tokenManager.removeToken();
      // 可以在这里触发重定向到登录页
      window.location.href = '/login';
    }

    // 403 错误：权限不足
    if (error.response?.status === 403) {
      console.error('Permission denied');
    }

    // 500 错误：服务器错误
    if (error.response?.status === 500) {
      console.error('Server error:', error.response.data);
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
