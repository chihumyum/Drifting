import apiClient, { handleApiError, tokenManager } from '../lib/api';
import log from "loglevel";

log.setLevel(log.levels.ERROR);

export interface User {
  id: string;
  email: string;
  username: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  email: string;
  username: string;
  password: string;
}

export interface AuthResponse {
  accessToken: string;
  user: User;
}

/**
 * 认证服务 - 对应后端 /auth API
 */
export const authService = {
  /**
   * 用户登录
   */
  async login(email: string, password: string): Promise<AuthResponse> {
    try {
      const response = await apiClient.post<AuthResponse>('/auth/login', {
        email,
        password,
      });
      
      // 保存 token
      tokenManager.setToken(response.data.accessToken);
      
      return response.data;
    } catch (error) {
      throw new Error(`Login failed: ${handleApiError(error)}`);
    }
  },

  /**
   * 用户注册
   */
  async register(data: RegisterInput): Promise<AuthResponse> {
    try {
      const response = await apiClient.post<AuthResponse>('/auth/register', data);
      
      // 保存 token
      tokenManager.setToken(response.data.accessToken);
      
      return response.data;
    } catch (error) {
      throw new Error(`Registration failed: ${handleApiError(error)}`);
    }
  },

  /**
   * 用户登出
   */
  async logout(): Promise<void> {
    try {
      await apiClient.post('/auth/logout');
    } catch (error) {
      log.error('Logout error:', handleApiError(error));
    } finally {
      // 无论是否成功，都清除本地 token
      tokenManager.removeToken();
    }
  },

  /**
   * 刷新 token
   */
  async refreshToken(): Promise<{ accessToken: string }> {
    try {
      const response = await apiClient.post<{ accessToken: string }>('/auth/refresh');
      
      // 更新 token
      tokenManager.setToken(response.data.accessToken);
      
      return response.data;
    } catch (error) {
      throw new Error(`Failed to refresh token: ${handleApiError(error)}`);
    }
  },

  /**
   * 获取当前用户信息
   */
  async getCurrentUser(): Promise<User> {
    try {
      const response = await apiClient.get<User>('/auth/me');
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get current user: ${handleApiError(error)}`);
    }
  },

  /**
   * 检查是否已登录
   */
  isAuthenticated(): boolean {
    return tokenManager.getToken() !== null;
  },
};
