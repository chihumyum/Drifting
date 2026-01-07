import apiClient, { handleApiError } from '../lib/api';
import type { User } from './auth.service';
import log from "loglevel";

log.setLevel(log.levels.ERROR);

export interface UpdateUserInput {
  username?: string;
  email?: string;
}

/**
 * 用户服务 - 对应后端 /users API
 */
export const userService = {
  /**
   * 根据 ID 获取用户
   */
  async findById(id: string): Promise<User | null> {
    try {
      const response = await apiClient.get<User>(`/users/${id}`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch user:', handleApiError(error));
      return null;
    }
  },

  /**
   * 根据邮箱获取用户
   */
  async findByEmail(email: string): Promise<User | null> {
    try {
      const response = await apiClient.get<User>(`/users/by-email/${email}`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch user by email:', handleApiError(error));
      return null;
    }
  },

  /**
   * 更新用户信息
   */
  async update(id: string, data: UpdateUserInput): Promise<User> {
    try {
      const response = await apiClient.patch<User>(`/users/${id}`, data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to update user: ${handleApiError(error)}`);
    }
  },
};
