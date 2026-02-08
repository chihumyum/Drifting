/**
 * Auth API Service
 * 
 * 调用后端 /api/auth 相关接口
 */

import axios from 'axios';

const BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_URL ||
  'http://localhost:3000';

// DTO 类型定义
export interface RegisterDto {
  email: string;
  password: string;
  name: string;
}

export interface LoginDto {
  email: string;
  password: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl?: string;
    subscriptionTier: string;
    createdAt: string;
    updatedAt: string;
  };
}

export interface RefreshTokenDto {
  refreshToken: string;
}

/**
 * Auth API 客户端
 */
export const authApi = {
  /**
   * 用户注册
   * POST /api/auth/register
   */
  async register(dto: RegisterDto): Promise<AuthResponse> {
    const response = await axios.post(`${BASE_URL}/api/auth/register`, dto);
    return response.data;
  },

  /**
   * 用户登录
   * POST /api/auth/login
   */
  async login(dto: LoginDto): Promise<AuthResponse> {
    const response = await axios.post(`${BASE_URL}/api/auth/login`, dto);
    return response.data;
  },

  /**
   * 刷新 Token
   * POST /api/auth/refresh
   */
  async refreshToken(dto: RefreshTokenDto): Promise<{ accessToken: string }> {
    const response = await axios.post(`${BASE_URL}/api/auth/refresh`, dto);
    return response.data;
  },

  /**
   * 获取当前用户信息
   * GET /api/auth/me
   */
  async getCurrentUser(): Promise<AuthResponse['user']> {
    const response = await axios.get(`${BASE_URL}/api/auth/me`);
    return response.data;
  },

  /**
   * 登出（可选，如果后端有实现）
   * POST /api/auth/logout
   */
  async logout(): Promise<void> {
    try {
      await axios.post(`${BASE_URL}/api/auth/logout`);
    } catch (error: any) {
      const status = error?.response?.status;
      // Backend may not implement this endpoint; treat as a no-op.
      if (status === 404) return;
      throw error;
    }
  },
};
