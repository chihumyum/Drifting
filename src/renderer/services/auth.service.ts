import { authClient } from '../lib/auth-client';
import loglevel from "loglevel";

const log = loglevel.getLogger("AuthService");
log.setLevel(loglevel.levels.ERROR);

export interface User {
  id: string;
  email: string;
  name: string;
  image?: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  email: string;
  name: string;
  password: string;
}

/**
 * 认证服务 - 使用 better-auth
 */
export const authService = {
  /**
   * 用户登录
   */
  async login(email: string, password: string): Promise<User | null> {
    try {
      const result = await authClient.signIn.email({
        email,
        password,
      });
      
      if (result.error) {
        throw new Error(result.error.message || 'Login failed');
      }
      
      return result.data?.user as User;
    } catch (error) {
      throw new Error(`Login failed: ${error}`);
    }
  },

  /**
   * 用户注册
   */
  async register(data: RegisterInput): Promise<User | null> {
    try {
      const result = await authClient.signUp.email({
        email: data.email,
        password: data.password,
        name: data.name,
      });
      
      if (result.error) {
        throw new Error(result.error.message || 'Registration failed');
      }
      
      return result.data?.user as User;
    } catch (error) {
      throw new Error(`Registration failed: ${error}`);
    }
  },

  /**
   * 用户登出
   */
  async logout(): Promise<void> {
    try {
      await authClient.signOut();
    } catch (error) {
      log.error('Logout error:', error);
      throw error;
    }
  },

  /**
   * 获取当前会话
   */
  async getSession() {
    try {
      const result = await authClient.getSession();
      return result.data;
    } catch (error) {
      throw new Error(`Failed to get session: ${error}`);
    }
  },

  /**
   * 获取当前用户信息
   */
  async getCurrentUser(): Promise<User | null> {
    try {
      const session = await this.getSession();
      return session?.user as User;
    } catch (error) {
      throw new Error(`Failed to get current user: ${error}`);
    }
  },

  /**
   * 检查是否已登录
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      const session = await this.getSession();
      return !!session;
    } catch {
      return false;
    }
  },
};
